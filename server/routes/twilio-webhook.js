const express = require('express');
const router = express.Router();
const db = require('../models/db');
const TWILIO_NUMBERS = require('../config/twilio-numbers');
const TwilioService = require('../services/twilio');
const logger = require('../services/logger');
const { etDateString } = require('../utils/datetime-et');
const { createDefaultCustomerRows } = require('../services/customer-default-rows');
const { recordSuppression, clearSuppression } = require('../services/messaging/validators/suppression');
const { detectSmsOptCommand } = require('../services/messaging/opt-out-detector');
const { tryClaimInboundWebhook, releaseInboundWebhook } = require('../services/messaging/inbound-dedupe');
const { updateByTwilioSid } = require('../services/conversations');
const { uploadTwilioMedia } = require('../services/sms-media');
const { alertTwilioFailure, isFailureStatus } = require('../services/twilio-failure-alerts');
const { hasSchedulingIntent, isSmsReaction, isCourtesyOnly, hasRescheduleOrAwayIntent } = require('../services/sms-intent');
const { publicPortalUrl } = require('../utils/portal-url');
const { properCase } = require('../utils/name-case');
const { applyContactNormalization } = require('../utils/intake-normalize');

// Admin alert recipient — must be a real cell, never one of our own Twilio
// numbers (an SMS from the HQ line to itself fails with Twilio error 21266).
const ADMIN_ALERT_PHONE = process.env.ADAM_PHONE || '+19415993489';

function notifyTwilioFailure(payload) {
  void alertTwilioFailure(payload).catch((err) => {
    logger.error(`[twilio-alerts] async notification failed: ${err.message}`);
  });
}

function normalizeE164(phone) {
  if (!phone) return null;
  const trimmed = String(phone).trim();
  const digits = trimmed.replace(/\D/g, '');
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith('1')) return `+${digits}`;
  return trimmed.startsWith('+') ? trimmed : trimmed || null;
}

function phoneDigits(phone) {
  return String(phone || '').replace(/\D/g, '');
}

function phoneLookupKey(phone) {
  const normalized = normalizeE164(phone);
  const digits = phoneDigits(normalized || phone);
  if (!digits) return '';
  return digits.length >= 10 ? digits.slice(-10) : digits;
}

function maskPhone(phone) {
  const digits = phoneDigits(phone);
  return digits.length >= 4 ? `***${digits.slice(-4)}` : '***';
}

async function findSingleCustomerByPhone(phone) {
  const key = phoneLookupKey(phone);
  if (!key) return null;

  const matches = await db('customers')
    .whereNull('deleted_at')
    .whereRaw("RIGHT(regexp_replace(COALESCE(phone, ''), '[^0-9]', '', 'g'), 10) = ?", [key])
    .orderBy('updated_at', 'desc')
    .limit(2);

  if (matches.length === 1) return matches[0];
  if (matches.length > 1) {
    logger.warn(`[sms] ${matches.length} customers share sender phone ${maskPhone(phone)}; not auto-linking inbound SMS`);
  }
  return null;
}

function cleanIntroNameSegment(segment) {
  const text = String(segment || '')
    .replace(/[“”]/g, '"')
    .replace(/[’]/g, "'")
    .split(/[.,;!?]/)[0]
    .replace(/\s+(?:and|but|because|who|that|i|we)\b.*$/i, '')
    .replace(/\s+(?:from|in|at|with|seeking|looking|need|needs|want|wants|live|lives|located)\b.*$/i, '')
    .trim();
  const words = text.match(/[a-z][a-z' -]*/gi);
  if (!words) return '';
  const candidate = words.join(' ').replace(/\s+/g, ' ').trim();
  const lower = candidate.toLowerCase();
  const firstWord = lower.split(' ')[0];
  if (
    !candidate ||
    [
      'about', 'at', 'for', 'from', 'in', 'located', 'live', 'lives', 'looking',
      'need', 'needs', 'interested', 'seeking', 'trying', 'want', 'wants', 'with',
    ].includes(firstWord) ||
    /^(a|an|the|quote|service|pest|rodent|lawn|customer|homeowner|property)$/i.test(lower)
  ) {
    return '';
  }
  return properCase(candidate.split(' ').slice(0, 3).join(' '));
}

function extractContactNameFromSms(body) {
  const text = String(body || '').replace(/\s+/g, ' ').trim();
  if (!text) return null;

  const patterns = [
    /\bmy\s+name\s+is\s+(.{1,80})/i,
    /\bthis\s+is\s+(.{1,80})/i,
    /\bi['’]?m\s+(.{1,80})/i,
    /\bi\s+am\s+(.{1,80})/i,
  ];

  for (const pattern of patterns) {
    const match = text.match(pattern);
    const fullName = cleanIntroNameSegment(match?.[1]);
    if (!fullName) continue;
    const parts = fullName.split(/\s+/);
    return {
      fullName,
      firstName: parts[0] || '',
      lastName: parts.slice(1).join(' '),
    };
  }

  return null;
}

// POST /api/webhooks/twilio/sms — inbound SMS webhook
// How the inbound handler must treat a lead-intake result. Extracted and
// exported so the rule is pinnable — it decides whether an inbound text
// reaches the bell/push/owner-forward block at the bottom of the handler.
//   'consumed'                — the machine ANSWERED the customer; it owns
//                               the reply end to end and the handler returns.
//   'continue_without_quote'  — the machine REFUSED TO QUOTE (scope veto)
//                               and said nothing. Quote paths are skipped;
//                               everything else (logging, bell, push,
//                               owner-forward) runs exactly as for any
//                               other inbound message. Suppressing the
//                               draft is a quoting decision, not a reason
//                               to swallow a customer's message.
//   'continue'                — not an intake reply at all.
function intakeOutcome(intakeResult) {
  if (!intakeResult?.handled) return 'continue';
  return intakeResult.terminal ? 'continue_without_quote' : 'consumed';
}

router.post('/sms', async (req, res) => {
  // Whether THIS delivery actually took the dedupe ledger row. Only an owner
  // may release the claim on error (a fail-open delivery must not delete a
  // sibling delivery's good claim). Declared out here so the catch can read it.
  let claimOwned = false;
  // Flipped true once a non-idempotent write keyed to this SID has committed
  // (the inbound sms_log row). After that we must NOT release the claim on a
  // later error — sms_log.twilio_sid is not unique, so a Twilio retry would
  // duplicate the row. Better to keep the (already-logged) message claimed.
  let persisted = false;
  // Contact-correction queue slot + whether a branch actually ran it.
  // Declared out here so the route-level finally can release an un-run
  // reservation on EVERY exit path (round-15) — early returns, throws, and
  // branches that never reach a fire site all unwind the sender's queue
  // position instead of leaning on the wall-clock backstop.
  let correctionJobId = null;
  let correctionFired = false;
  try {
    const { isEnabled } = require('../config/feature-gates');
    if (!isEnabled('webhooks')) {
      logger.info(`[GATE BLOCKED] Inbound SMS webhook from ${maskPhone(req.body.From)} (gate: webhooks)`);
      return res.type('text/xml').send('<Response></Response>');
    }

    const { From, To, Body, MessageSid } = req.body;
    const smsReaction = isSmsReaction(Body);
    const contactCorrection = require('../services/contact-correction');
    const correctionQueue = require('../services/contact-correction-queue');
    // Ordering token at TRUE entry (codex #3413 r29): the reservation's
    // bigserial id IS source order, so it must be taken before the
    // variable-latency idempotency/spam awaits — two rapid messages could
    // otherwise reserve in the wrong order and the worker would rebase the
    // older write over the newer one. The BODY is withheld until the
    // eligibility gates pass (r27 storage boundary): blocked traffic
    // leaves only a body-less row for the finally to cancel.
    correctionJobId = shouldReserveCorrectionJob(Body, smsReaction)
      ? await correctionQueue.reserveContactCorrectionJob({ senderPhone: From, messageSid: MessageSid })
      : null;
    const schedulingIntent = hasSchedulingIntent(Body);
    // NOT a subset of schedulingIntent (codex #3232 r10): away phrases
    // ("I won't be home") carry no scheduling keyword — the AI auto-reply
    // gates must stand down for these too.
    const rescheduleAsk = Body ? hasRescheduleOrAwayIntent(Body) : false;

    // ── Idempotency claim (must run before spam-block + all side-effects) ──
    // Twilio can redeliver the same MessageSid (edge retry, a slow handler
    // that blew the ~15s timeout, or a FallbackUrl re-hitting us). Claim the
    // SID atomically BEFORE spam-block, so a confirmed redelivery short-circuits
    // before it can re-write blocked_call_attempts / re-log / double-alert /
    // send a second AI auto-reply (RED audit R1). Genuine first deliveries fall
    // through to spam-block as before. Fails open (processable but not owned) so
    // a dedupe outage never drops a message; we release on error only when we
    // actually own the claim.
    const smsClaim = await tryClaimInboundWebhook(MessageSid, 'sms');
    claimOwned = smsClaim.owned;
    if (!smsClaim.processable) {
      logger.info(`[twilio-webhook] Duplicate inbound SMS ${MessageSid} ignored (already processed)`);
      // With concurrent duplicate deliveries, the reservation may be
      // ADOPTED by the claim-winning sibling request (codex #3413 r31) —
      // the loser must not let its finally cancel the row out from under
      // the winner. A true orphan (winner also died) is a body-less
      // reserved row the stale sweep cancels.
      correctionJobId = null;
      return res.type('text/xml').send('<Response></Response>');
    }

    // ── Spam block (must run before any other routing) ──
    const { checkInboundBlock } = require('../middleware/spam-block');
    const blockResult = await checkInboundBlock({ from: From, to: To, channel: 'sms', twilioSid: MessageSid });
    if (blockResult.blocked) return res.type('text/xml').send(blockResult.twiml);

    const numberConfig = TWILIO_NUMBERS.findByNumber(To);

    if (!numberConfig) {
      logger.info(`Inbound SMS to unmanaged number ${To} — ignoring`);
      return res.type('text/xml').send('<Response></Response>');
    }

    // Eligibility gates passed — attach the body to the entry reservation
    // (codex #3413 r27/r29). A DURABLE row (round-17): a crash from here
    // on is replayed by the queue worker — the recovery for a message
    // whose MessageSid claim is durable but whose detached run died
    // (Twilio's retry is ignored). Whether the sender maps to a linked
    // customer is decided at fire time; unlinked/unused reservations are
    // cancelled (body scrubbed).
    if (correctionJobId) await correctionQueue.attachReservationBody(correctionJobId, Body);
    // Context attaches BEFORE the media await (codex #3413 r35): an MMS
    // fetch/upload can stall, and a crash in that window used to leave a
    // body-only reservation the sweep cancels as context-free while the
    // durable SID claim suppresses Twilio's redelivery — permanently
    // losing the correction. The attach performs its OWN single-customer
    // match, snapshot, and floor capture under one customer lock (r33);
    // the route's later read is for routing only.
    if (correctionJobId) {
      await correctionQueue.attachContactCorrectionContext(correctionJobId, { senderPhone: From });
    }

    const inboundMedia = await uploadTwilioMedia(req.body);
    // Pure courtesy closer ("Thanks!", "Ok great", "👍"): lands in the thread
    // already read, no bell/push/owner forward, no AI auto-reply. The shadow
    // drafter still sees it (knowing when NOT to reply is a judged class).
    // isCourtesyOnly is fail-safe: any question/scheduling/mixed content → false.
    // An attachment is content — a photo captioned "Thanks" stays loud.
    // (Computed after the media upload: needs inboundMedia — hook P0.)
    // Bare affirmatives / 👍 are closers only when OUR last text did not ask
    // a question; that context comes from sms_log, fail-closed (unknown →
    // treated as awaiting an answer → stays loud). The DB read only runs for
    // grammar candidates, never on every inbound.
    let courtesyOnly = false;
    if (!smsReaction && inboundMedia.length === 0 && isCourtesyOnly(Body, { awaitingAnswer: false })) {
      courtesyOnly = isCourtesyOnly(Body, { awaitingAnswer: await lastOutboundAskedQuestion(From, To) });
    }

    // Try to match sender to a single active customer. Twilio sends E.164,
    // while older customer rows may still have local formatting.
    const customer = await findSingleCustomerByPhone(From);

    // Event-driven health rescore on a hot inbound signal (competitor mention,
    // cancellation, price complaint). Fire-and-forget so it never delays the
    // webhook ack; gated behind GATE_EVENT_RESCORE (no-op when off). Defined
    // here so it can fire on BOTH the early-return branches (opt-out/cancel —
    // the strongest churn signal) and the general inbound path.
    const fireEventRescore = (src) => {
      if (!customer?.id) return;
      void require('../services/customer-intelligence/event-rescore')
        .rescoreOnInboundMessage(customer.id, { source: src })
        .catch(err => logger.debug(`[twilio-webhook] event rescore failed: ${err.message}`));
    };

    // An intent-bearing message from a number with NO linked customer will
    // never fire a correction — release its reserved queue position now.
    if (correctionJobId && !customer?.id) {
      void correctionQueue.cancelContactCorrectionJob(correctionJobId, 'unlinked');
      correctionJobId = null;
    }
    // Stamp the reservation with its SOURCE-TIME context the moment the
    // sender matches (codex #3413 r19): linkage + the match-time CAS
    // baseline. If this process dies before a branch fires, the stale
    // sweep replays exactly what was matched here — it never re-derives
    // linkage from current phone ownership, and a reservation that died
    // before this stamp (or on a pre-match exit path like spam-block) is
    // cancelled instead of promoted. Awaited: an unstamped crash window
    // fails closed, a stamped one replays faithfully.
    const fireContactCorrection = async (smsLogId) => {
      if (!correctionJobId || !customer?.id) return;
      // Marked synchronously so the route-level finally never cancels a
      // reservation a branch decided to run.
      correctionFired = true;
      // expectedValues: the CAS baseline from the customer row AS MATCHED
      // at webhook entry (round-15) — persisted on the job so an admin
      // edit made while this message waits in the queue reads as a
      // concurrent change even after a deploy. The enqueue is AWAITED
      // before the TwiML ack (round-17): once it commits, the correction
      // survives the process. Fail-soft — an enqueue error leaves the row
      // 'reserved' for the worker's stale sweep to replay, and never
      // affects inbound SMS handling.
      const enqueued = await correctionQueue.enqueueContactCorrectionJob(correctionJobId, {
        customerId: customer.id,
        smsLogId: smsLogId || null,
        // Body rides the queued transition too (r32) — a transiently
        // failed earlier attach must not queue a body-less job. The CAS
        // baseline lives on the row from the r33 single-lock attach.
        body: Body,
      });
      if (enqueued) correctionQueue.kickContactCorrectionQueue();
      else logger.warn(`[contact-correction] enqueue deferred to stale sweep for customer ${customer.id}, sms_log ${smsLogId || 'n/a'}`);
    };

    // Dual-write to unified messages table. Awaited (fail-soft — the catch
    // keeps the legacy sms_log path serving Virginia's inbox on error) so the
    // message row exists BEFORE the sms_reply bell below is written: the
    // thread-read bell cross-clear only clears bells for threads with no
    // unread message, which needs message-before-bell ordering (hook P1).
    await require('../services/conversations').recordTouchpoint({
      customerId: customer?.id,
      channel: 'sms',
      ourEndpointId: To,
      contactPhone: From,
      direction: 'inbound',
      body: Body,
      authorType: 'customer',
      twilioSid: MessageSid,
      media: inboundMedia,
      // Reactions and pure courtesy closers never needed a human to "open"
      // them — write the row already read so the Messages unread dot and
      // the Unread chip only count messages that want an answer.
      isRead: smsReaction || courtesyOnly,
      messageType: smsReaction ? 'sms_reaction' : undefined,
      metadata: { location: numberConfig?.label, numberType: numberConfig?.type, ...(courtesyOnly ? { courtesyOnly: true } : {}) },
    }).catch(() => {});

    // ── STOP / UNSUBSCRIBE keyword handling ──
    const optCommand = detectSmsOptCommand(Body);

    if (optCommand.action === 'opt_out') {
      const normalizedFrom = normalizeE164(From);
      await recordSuppression({
        phone: normalizedFrom || From,
        reason: optCommand.reason,
        source: `twilio_webhook_${optCommand.detectionMethod}`,
        capturedBody: Body,
      });
      // Recipient double opt-in: a pending third-party recipient who replies
      // STOP is recorded as declined (no-op when no recipient row exists).
      try {
        await require('../services/recipient-optin').markRecipientOptin(normalizedFrom || From, 'declined');
      } catch { /* never block the STOP path */ }
      try {
        if (customer) {
          await db('notification_prefs')
            .insert({ customer_id: customer.id, sms_enabled: false })
            .onConflict('customer_id')
            .merge({ sms_enabled: false });
        }
        logger.info(`[sms-optout] ${customer ? `Customer ${customer.id}` : `Unknown sender ${maskPhone(From)}`} opted out of SMS via ${optCommand.detectionMethod}`);
      } catch (e) { logger.error(`[sms-optout] Failed to update prefs: ${e.message}`); }

      let optOutSmsLogId = null;
      try {
        const inserted = await db('sms_log').insert({
          customer_id: customer?.id || null, direction: 'inbound', from_phone: From, to_phone: To,
          message_body: Body, twilio_sid: MessageSid, status: 'received', message_type: 'opt_out',
          metadata: JSON.stringify({
            opt_out_reason: optCommand.reason,
            detection_method: optCommand.detectionMethod,
            source_keyword: optCommand.sourceKeyword,
          }),
        }).returning('id');
        optOutSmsLogId = inserted?.[0]?.id ?? inserted?.[0] ?? null;
      } catch { /* logging is best-effort, as before */ }
      // A natural-language opt-out can still CONTAIN an explicit contact
      // correction ("Please stop texting me; my email is wrong, use …") —
      // this return is unreachable by the correction block below, so it
      // enqueues here too (codex #3413 r23). The opt-out governs comms;
      // it does not void a stated data fix. Linked customers only, as
      // everywhere (fireContactCorrection no-ops for unmatched senders).

      if (customer) {
        await db('activity_log').insert({
          customer_id: customer.id, action: 'sms_opt_out',
          description: `${customer.first_name} ${customer.last_name} unsubscribed from SMS (${optCommand.detectionMethod})`,
          metadata: JSON.stringify({
            opt_out_reason: optCommand.reason,
            detection_method: optCommand.detectionMethod,
            source_keyword: optCommand.sourceKeyword,
          }),
        }).catch(() => {});
      }

      // An opt-out / "CANCEL" is the strongest churn signal there is — rescore
      // and alert the owner now rather than waiting for the nightly pipeline.
      // (The alert is internal to the owner, unaffected by the SMS opt-out.)
      fireEventRescore('sms_opt_out');

      // Opt-out COMBINED with an appointment ask (codex #3232 r45/r46):
      // "STOP, and cancel tomorrow's service" — the durable reschedule
      // flag and its INTERNAL bell still persist; only customer-facing
      // SMS is suppressed by the opt-out. Service contacts resolve via
      // the same all-slots unique lookup as the main flag path.
      if (Body && rescheduleAsk) {
        let optFlagCustomer = customer;
        let optFlagEligible = Boolean(customer);
        if (!customer) {
          const key = phoneLookupKey(From);
          if (key) {
            const matches = await db('customers')
              .whereNull('deleted_at')
              .where(function anyPhoneSlot() {
                for (const col of ['phone', 'service_contact_phone', 'service_contact2_phone', 'service_contact3_phone']) {
                  this.orWhereRaw(`RIGHT(regexp_replace(COALESCE(${col}, ''), '[^0-9]', '', 'g'), 10) = ?`, [key]);
                }
              })
              .limit(2)
              .catch(() => []);
            if (matches.length === 1) {
              optFlagCustomer = matches[0];
              optFlagEligible = true;
            } else {
              optFlagEligible = matches.length > 1;
            }
          }
        }
        if (optFlagEligible) {
          const flagResult = await require('../services/reschedule-intent-flagger')
            .flagInboundRescheduleIntent({
              customer: optFlagCustomer,
              phone: From,
              body: Body,
              smsLogId: null,
              messageSid: MessageSid || null,
            })
            .catch(() => null);
          if (flagResult?.flagged === true && typeof flagResult.fireBell === 'function') {
            setImmediate(() => { flagResult.fireBell().catch(() => {}); });
          }
        }
      }

      // NEVER on a wrong-number declaration (codex #3413 r25): "Wrong
      // number. The email is wrong; change it to …" invalidates the
      // sender-identity anchor — the matched customer is the number's
      // FORMER owner, and a correction from the new holder must not touch
      // their record. The un-fired reservation is released by the
      // route-level finally.
      if (optCommand.reason !== 'wrong_number') {
        await fireContactCorrection(optOutSmsLogId);
      }

      return res.type('text/xml').send(
        `<Response><Message>You've been unsubscribed from Waves Pest Control SMS. Reply START to re-subscribe.</Message></Response>`
      );
    }

    // HELP/INFO: the opt-in ask copy advertises "HELP for help" — answer it
    // (carrier compliance) instead of letting it fall into normal routing.
    const { detectHelp, HELP_RESPONSE_TEMPLATE } = require('../services/messaging/opt-out-detector');
    if (detectHelp(Body).help) {
      await db('sms_log').insert({
        customer_id: customer?.id || null, direction: 'inbound', from_phone: From, to_phone: To,
        message_body: Body, twilio_sid: MessageSid, status: 'received', message_type: 'help_request',
      }).catch(() => {});
      const xmlEscape = (t) => String(t).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
      // A HELP command can still CONTAIN a correction ("HELP. My email is
      // wrong; use …") — enqueue like the other consumed branches (r35).
      await fireContactCorrection(null);
      return res.type('text/xml').send(`<Response><Message>${xmlEscape(HELP_RESPONSE_TEMPLATE)}</Message></Response>`);
    }

    if (optCommand.action === 'opt_in') {
      const normalizedFrom = normalizeE164(From);
      // The inbound log lands BEFORE the clear (codex #3495 P1): a late
      // 21610 callback's post-write recheck discovers a concurrent START by
      // this row. With clear-first, a START against a not-yet-existing
      // suppression row no-opped AND left no marker, so a redelivered 21610
      // interleaving there could re-suppress an opted-in recipient with
      // nothing to find. Log-then-clear closes the ordering: either the
      // 21610 wrote first (this clear removes it) or the 21610 runs later
      // (its recheck sees this logged START and undoes itself).
      // Marker + clear are ATOMIC under the same per-phone advisory lock
      // the 21610 recorders take (hook P1): with the lock, a concurrent
      // callback either commits first (this clear removes its row and the
      // tombstone timestamps the opt-in) or blocks until this commits and
      // then finds the START row/tombstone in its recheck. A failed log
      // insert no longer strands the ordering — the clearance TOMBSTONE
      // clearSuppression upserts is itself the durable marker, written in
      // the same transaction. The opt-in itself must never fail: any
      // transaction error falls back to the plain (unlocked) clear.
      const optInPhone = normalizedFrom || From;
      // Derived consent state (recipient confirm + prefs restore) applies
      // INSIDE the same advisory-locked transaction as the clear (hook P1):
      // written afterwards unlocked, a newer 21610 could take the lock,
      // suppress, decline the recipient, and flip prefs off — and these
      // stale START writes would then overwrite that newer verdict. In-trx
      // fail-loud: markRecipientOptin returns FALSE on a swallowed SQL
      // error that has already aborted the transaction (hook r12 trap).
      const applyStartDerivedState = async (dbh, { failLoud }) => {
        const confirmed = await require('../services/recipient-optin')
          .markRecipientOptin(optInPhone, 'confirmed', { dbh });
        if (failLoud && confirmed === false) {
          throw Object.assign(new Error('recipient confirm write reported failure'), { code: 'recipient_confirm_failed' });
        }
        if (customer) {
          await dbh('notification_prefs')
            .insert({ customer_id: customer.id, sms_enabled: true })
            .onConflict('customer_id')
            .merge({ sms_enabled: true });
        }
      };
      let optInLanded = true;
      try {
        await db.transaction(async (trx) => {
          await trx.raw("SELECT pg_advisory_xact_lock(hashtext('twilio_21610'), hashtext(?::text))", [optInPhone]);
          await trx('sms_log').insert({
            customer_id: customer?.id || null, direction: 'inbound', from_phone: From, to_phone: To,
            message_body: Body, twilio_sid: MessageSid, status: 'received', message_type: 'opt_in',
            metadata: JSON.stringify({
              detection_method: optCommand.detectionMethod,
              source_keyword: optCommand.sourceKeyword,
            }),
          });
          // NO swallowed catch inside the transaction — a failed insert has
          // already ABORTED it (the trap this PR hit twice); let it throw
          // into the fallback below, where the plain clear still lands the
          // opt-in and the tombstone still timestamps it.
          const cleared = await clearSuppression({
            phone: optInPhone,
            source: `twilio_webhook_${optCommand.detectionMethod}`,
            dbh: trx,
          });
          if (cleared?.ok === false) {
            throw Object.assign(new Error('clearSuppression reported failure'), { code: 'suppression_clear_failed' });
          }
          await applyStartDerivedState(trx, { failLoud: true });
        });
      } catch (optInErr) {
        // Retry UNDER THE SAME LOCK without the marker insert (hook P1: an
        // unlocked fallback clear can interleave with a 21610 transaction
        // that read before this tombstone lands, re-suppressing an
        // explicitly opted-in recipient). The common abort cause is the
        // sms_log insert; the clearance tombstone alone is the durable
        // marker, so the retry drops the insert but keeps the serialization.
        logger.error(`[sms-optin] locked clear failed (${optInErr.code || optInErr.message}) — retrying under the lock without the marker insert`);
        try {
          await db.transaction(async (trx) => {
            await trx.raw("SELECT pg_advisory_xact_lock(hashtext('twilio_21610'), hashtext(?::text))", [optInPhone]);
            const cleared = await clearSuppression({
              phone: optInPhone,
              source: `twilio_webhook_${optCommand.detectionMethod}`,
              dbh: trx,
            });
            if (cleared?.ok === false) {
              throw Object.assign(new Error('clearSuppression reported failure'), { code: 'suppression_clear_failed' });
            }
            await applyStartDerivedState(trx, { failLoud: true });
          });
        } catch (retryErr) {
          // Both locked attempts failed — the DB itself is misbehaving (a
          // concurrent 21610 writer is in the same storm). The opt-in must
          // never be dropped: land the plain clear as the last resort,
          // with the derived state best-effort behind it.
          logger.error(`[sms-optin] locked retry also failed (${retryErr.code || retryErr.message}) — last-resort plain clear`);
          const lastResort = await clearSuppression({
            phone: optInPhone,
            source: `twilio_webhook_${optCommand.detectionMethod}`,
          });
          // clearSuppression swallows DB errors to { ok: false } — the
          // last resort must not report success on top of a failed clear
          // (hook #3495 r17): suppression would stay ACTIVE while the
          // customer is told START worked and nothing alerts anyone.
          // Fail LOUD to the admin bell (the compliance backstop rings
          // even when the bell policy would mute 'system'), skip the
          // derived consent restore (it must not outrank a standing
          // suppression), and leave the failure in the log.
          if (lastResort?.ok === false) {
            optInLanded = false;
            logger.error(`[sms-optin] LAST-RESORT clear also failed for ${maskPhone(From)} — suppression may still be active after an explicit START`);
            try {
              await require('../services/notification-service').notifyAdmin(
                'system',
                'START opt-in could not be recorded',
                `An explicit START from ${maskPhone(From)} could not clear the SMS suppression after three attempts (DB errors). The number may still be blocked — clear the suppression by hand from the do-not-text list.`,
                { bell: true, metadata: { source: `twilio_webhook_${optCommand.detectionMethod}` } },
              );
            } catch (notifyErr) {
              logger.error(`[sms-optin] opt-in failure notify also failed: ${notifyErr.message}`);
            }
          } else {
            try {
              await applyStartDerivedState(db, { failLoud: false });
            } catch (e) { logger.error(`[sms-optin] derived-state fallback failed: ${e.message}`); }
          }
        }
      }
      // Success reporting is gated on the clear actually landing (hook
      // #3495 r17): after a failed last-resort clear the suppression may
      // still be ACTIVE — logging, timeline-stamping, and replying
      // "re-subscribed" would all misreport it, and nothing else would
      // surface the miss (the admin bell above owns that). The reply then
      // stays factual: the request was received, not honored yet.
      if (optInLanded) {
        logger.info(`[sms-optin] ${customer ? `Customer ${customer.id}` : `Unknown sender ${maskPhone(From)}`} re-subscribed to SMS`);
        // (inbound sms_log row inserted above, BEFORE the clear — see the
        // ordering comment at the top of this branch.)
        if (customer) {
          await db('activity_log').insert({
            customer_id: customer.id, action: 'sms_opt_in',
            description: `${customer.first_name} ${customer.last_name} re-subscribed to SMS`,
          }).catch(() => {});
        }
      }

      // A START/opt-in can still CONTAIN a correction ("START. My email
      // changed to …") — enqueue like the other consumed branches (r35).
      await fireContactCorrection(null);

      return res.type('text/xml').send(optInLanded
        ? `<Response><Message>You've been re-subscribed to Waves Pest Control SMS.</Message></Response>`
        : `<Response><Message>We received your request to receive texts from Waves Pest Control. Our office will confirm your subscription shortly.</Message></Response>`);
    }

    if (smsReaction) {
      await db('sms_log').insert({
        customer_id: customer?.id || null,
        direction: 'inbound', from_phone: From, to_phone: To,
        message_body: Body, twilio_sid: MessageSid, status: 'received',
        message_type: 'sms_reaction',
        is_read: true, // read on arrival — mirrors the unified messages row (hook P1)
        metadata: JSON.stringify({
          locationId: numberConfig.locationId,
          source: numberConfig.type,
          domain: numberConfig.domain,
          media: inboundMedia,
        }),
      }).catch(() => {});

      logger.info('[sms-intent] SMS reaction detected; skipping automated inbound handling');
      return res.type('text/xml').send('<Response></Response>');
    }

    // Check for pending reschedule reply FIRST
    if (customer && numberConfig.type === 'location') {
      try {
        const RescheduleSMS = require('../services/reschedule-sms');
        const rescheduleResult = await RescheduleSMS.handleRescheduleReply(customer.id, Body);
        if (rescheduleResult?.handled) {
          logger.info(`Reschedule reply handled for ${customer.first_name}: ${rescheduleResult.action}`);
          // Still log the inbound message
          let rescheduleSmsLogId = null;
          try {
            const inserted = await db('sms_log').insert({
              customer_id: customer.id, direction: 'inbound', from_phone: From, to_phone: To,
              message_body: Body, twilio_sid: MessageSid, status: 'received', message_type: 'reschedule_reply',
            }).returning('id');
            rescheduleSmsLogId = inserted?.[0]?.id ?? inserted?.[0] ?? null;
          } catch { /* logging is best-effort, as before */ }
          // A handled reschedule reply can still CONTAIN an explicit contact
          // correction ("1. Also, my email is wrong; use …") — the
          // correction block further down is unreachable past this return,
          // so it fires here too (round-11), through the entry reservation.
          await fireContactCorrection(rescheduleSmsLogId);
          return res.type('text/xml').send('<Response></Response>');
        }
      } catch (e) { logger.error(`Reschedule reply check failed: ${e.message}`); }
    }

    // LEAD INTAKE STATE MACHINE — catches replies to the "What are you
    // interested in — Pest Control, Lawn Care, or One-Time Service?"
    // auto-reply that lead-webhook.js sends after a form submission.
    // Runs the intent classifier → asks for address → auto-creates a
    // draft estimate → SMS-notifies Adam at 941-599-3489. Only active
    // while lead_intake_status is set (seeded by lead-webhook).
    // intakeScopeVetoed: the intake machine REFUSED to quote (out-of-scope
    // trade, existing-job coordination, address veto) — no draft, and
    // nothing was said to the customer. That is a decision about QUOTING
    // only. The message itself is an ordinary inbound text and must still
    // reach the normal bell/push/owner-forward below, or a time-sensitive
    // service instruction ("this is for Friday's visit, please treat the
    // backyard") would exist only in the comms log for someone to find by
    // hand. Only the quote-generating branch is skipped.
    let intakeScopeVetoed = false;
    // A reschedule/away ask about an EXISTING visit must never be consumed
    // by the intake flow (codex #3232 r29) — consumption returns before
    // the durable reschedule flag below, silently dropping the guard.
    if (customer && Body && customer.lead_intake_status &&
        customer.lead_intake_status !== 'estimate_drafted' && !rescheduleAsk) {
      try {
        const LeadIntake = require('../services/lead-intake');
        const intakeResult = await LeadIntake.handleIntakeReply(customer, Body);
        const outcome = intakeOutcome(intakeResult);
        if (outcome === 'continue_without_quote') {
          logger.info(`[lead-intake] Scope-vetoed (no draft) for ${customer.first_name}: ${customer.lead_intake_status} — continuing to normal inbound handling`);
          intakeScopeVetoed = true;
        } else if (outcome === 'consumed') {
          // The machine ANSWERED the customer (asked for the address, or
          // drafted and alerted the owner) — it owns this reply end to end.
          logger.info(`[lead-intake] Handled for ${customer.first_name}: ${customer.lead_intake_status} → ${intakeResult.next}`);
          let intakeSmsLogId = null;
          try {
            const inserted = await db('sms_log').insert({
              customer_id: customer.id, direction: 'inbound', from_phone: From, to_phone: To,
              message_body: Body, twilio_sid: MessageSid, status: 'received',
              message_type: 'lead_intake',
            }).returning('id');
            intakeSmsLogId = inserted?.[0]?.id ?? inserted?.[0] ?? null;
          } catch { /* logging is best-effort, as before */ }
          // A consumed intake reply can still CONTAIN an explicit contact
          // correction (an awaiting_address customer correcting their email,
          // say) — the correction block further down is unreachable past
          // this return, so it fires here too (round-10), through the
          // entry reservation. The gate and the LLM extraction decide
          // whether anything applies.
          await fireContactCorrection(intakeSmsLogId);
          return res.type('text/xml').send('<Response></Response>');
        }
      } catch (e) { logger.error(`[lead-intake] Failed: ${e.message}`); }
    }

    // DOMAIN TRACKING — new lead from a domain-specific number
    if ((numberConfig.type === 'domain_tracking' || numberConfig.type === 'van_tracking') && !customer) {
      const leadSource = TWILIO_NUMBERS.getLeadSourceFromNumber(To);
      const { CREATED_VIA } = require('../services/customer-stages');
      const { resolveLocation } = require('../config/locations');
      const loc = resolveLocation(numberConfig.area || leadSource.area || '');
      const code = 'WAVES-' + Array.from({ length: 4 }, () => 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'[Math.floor(Math.random() * 32)]).join('');
      const inboundContactName = extractContactNameFromSms(Body);

      try {
        // Account layer: attach-or-create so the new lead profile is
        // login-complete (portal refresh sessions FK customer_accounts).
        // Lazy require: admin-customers is a route module (load-cycle risk).
        const { ensureCustomerAccount } = require('./admin-customers');
        const account = await ensureCustomerAccount(db, {
          firstName: inboundContactName?.firstName || 'Unknown',
          lastName: inboundContactName?.lastName || '',
          phone: From,
          email: null,
        });
        const [newCust] = await db('customers').insert(applyContactNormalization({
          account_id: account.accountId,
          is_primary_profile: !account.existingCustomer,
          profile_label: account.existingCustomer ? 'Additional property' : 'Primary',
          first_name: inboundContactName?.firstName || 'Unknown',
          last_name: inboundContactName?.lastName || '',
          phone: From, address_line1: '', city: numberConfig.area || '', state: 'FL', zip: '',
          referral_code: code, lead_source: leadSource.source,
          lead_source_detail: numberConfig.domain || leadSource.domain || 'Van wrap',
          lead_source_area: numberConfig.area || '', lead_source_channel: 'organic',
          nearest_location_id: numberConfig.location || loc.id,
          pipeline_stage: 'new_lead', pipeline_stage_changed_at: new Date(),
          // PROVENANCE stamp — this row is a placeholder minted for a number
          // nobody has identified yet. Consumers (estimator SMS context)
          // must be able to tell it from a genuine fresh lead, and row
          // shape cannot do that: a form submitted without an address
          // produces the same blank street/ZIP new_lead row.
          created_via: CREATED_VIA.TWILIO_TRACKING_SHELL,
          last_contact_date: new Date(), last_contact_type: Body ? 'sms_inbound' : 'call_inbound',
          member_since: etDateString(),
          crm_notes: `Inbound ${Body ? 'SMS' : 'call'} from ${numberConfig.domain || 'van wrap'}. ${Body ? 'Message: ' + Body : ''}`,
        })).returning('*');

        await createDefaultCustomerRows(db, newCust.id);

        try {
          const { triggerNotification } = require('../services/notification-triggers');
          const source = numberConfig.domain || 'van wrap';
          await triggerNotification('new_lead', {
            title: `New lead from ${source}`,
            name: inboundContactName?.fullName || 'Unknown prospect',
            phone: From,
            message: Body || 'Phone call',
            source,
            area: numberConfig.area || 'Unknown',
            leadId: newCust.id,
          });
        } catch (e) { logger.error(`Domain lead notification failed: ${e.message}`); }

        await db('activity_log').insert({
          customer_id: newCust.id, action: 'customer_created',
          description: `New lead from ${numberConfig.domain || 'van wrap'}: ${From}`,
        });
      } catch (e) { logger.error(`Domain lead creation failed: ${e.message}`); }
    }

    // ESTIMATOR SMS DRAFTS (GATE_ESTIMATOR_SMS_DRAFTS, default OFF): a
    // quote-flavored inbound text runs the estimator engine against the
    // thread — priced DRAFT + one phone-scoped bell, never a send. Runs
    // AFTER the domain/van tracking branch so a first-contact text to a
    // tracking number has its customer row before the context builds (an
    // earlier placement drafted unlinked). The AWAITED part is cheap and
    // bounded (regex prefilter → FAST classifier with a webhook-safe
    // timeout → one durable owed-quote bell); the DEEP composer detaches
    // inside startSmsThreadDraft AFTER that bell exists, so a restart
    // mid-compose leaves the manual task instead of a silent loss.
    // Intake-machine replies return above and draft through lead-intake's
    // own handoff.
    // A scope-vetoed intake reply already refused to quote — re-entering the
    // estimator here would re-litigate that decision on the same text.
    // Everything AFTER this block (logging, bell, push, owner-forward) still
    // runs for it; only quoting is skipped.
    try {
      // Clarify-reply routing first: a text answering a recently sent
      // clarifying question records the supplied fields onto the linked
      // lead/customer and resumes drafting itself (intent gate + cooldown
      // bypassed — the reply IS the new information). Only unanswered
      // texts fall through to the general quote-intent trigger. The
      // message continues into normal inbox handling either way.
      const { handleClarifyReply } = require('../services/estimate-clarify-asks');
      const clarifyReply = (!intakeScopeVetoed && Body && String(Body).trim())
        ? await handleClarifyReply({ phone: From, body: Body })
        : { handled: false };
      const { smsThreadDraftsEnabled, startSmsThreadDraft } = require('../services/estimator-engine/sms-thread');
      if (!intakeScopeVetoed && !clarifyReply.handled && smsThreadDraftsEnabled() && Body && String(Body).trim()) {
        await startSmsThreadDraft({ phone: From, triggerBody: Body });
      }
    } catch (e) { logger.warn(`[estimator-sms] trigger failed: ${e.message}`); }


    // Log inbound message
    const messageType = numberConfig.type === 'domain_tracking' ? 'domain_lead'
      : numberConfig.type === 'van_tracking' ? 'van_lead' : 'inbound';

    const [smsLogEntry] = await db('sms_log').insert({
      customer_id: customer?.id || null,
      direction: 'inbound', from_phone: From, to_phone: To,
      message_body: Body, twilio_sid: MessageSid, status: 'received',
      message_type: messageType,
      // Courtesy closers are read on arrival in the legacy log too, so the
      // sms_log-backed unread counts agree with the unified messages row.
      ...(courtesyOnly ? { is_read: true } : {}),
      metadata: JSON.stringify({
        locationId: numberConfig.locationId,
        source: numberConfig.type,
        domain: numberConfig.domain,
        media: inboundMedia,
        ...(courtesyOnly ? { courtesyOnly: true } : {}),
      }),
    }).returning(['id', 'created_at']);
    // The inbound message is now durably recorded — releasing the claim on a
    // later error would let a retry duplicate this row (twilio_sid not unique).
    persisted = true;

    // Reschedule/away flag persists AFTER the sms_log row and BEFORE the
    // Twilio ack (codex r18): the webhook SID claim short-circuits
    // retries, so any pre-log crash would lose the MESSAGE — strictly
    // worse than losing the flag. The residual row-without-flag window is
    // one awaited insert wide.
    // The bell fires post-ack via flagResult.fireBell.
    let rescheduleFlagResult = null;
    if (Body && !smsReaction && rescheduleAsk) {
      // No matched customer can mean a SHARED phone (findSingleCustomerByPhone
      // deliberately returns null on multiple actives) — those requests are
      // just as real, so persist an UNLINKED flag rather than dropping the
      // durable guard entirely (codex #3232 r25). Unknown numbers (zero
      // matches) stay in the lead lane.
      // Reminders go to service contacts too (codex r45): a reschedule
      // reply from service_contact*_phone must resolve to its customer,
      // not read as an unknown sender. A UNIQUE match across all phone
      // slots links the flag; multiple matches persist unlinked.
      let flagCustomer = customer;
      let flagEligible = Boolean(customer);
      if (!customer) {
        const key = phoneLookupKey(From);
        if (key) {
          const matches = await db('customers')
            .whereNull('deleted_at')
            .where(function anyPhoneSlot() {
              for (const col of ['phone', 'service_contact_phone', 'service_contact2_phone', 'service_contact3_phone']) {
                this.orWhereRaw(`RIGHT(regexp_replace(COALESCE(${col}, ''), '[^0-9]', '', 'g'), 10) = ?`, [key]);
              }
            })
            .limit(2)
            .catch(() => []);
          if (matches.length === 1) {
            flagCustomer = matches[0];
            flagEligible = true;
          } else {
            flagEligible = matches.length > 1;
          }
        }
      }
      if (flagEligible) {
        rescheduleFlagResult = await require('../services/reschedule-intent-flagger')
          .flagInboundRescheduleIntent({
            customer: flagCustomer,
            phone: From,
            body: Body,
            smsLogId: smsLogEntry?.id || null,
            messageSid: MessageSid || null,
          })
          .catch((err) => {
            logger.warn(`[reschedule-intent] flag rejected: ${err.message}`);
            return null;
          });
      }
    }

    // Customer-stated contact correction ("you spelled my name wrong, it's
    // …") — auto-applied behind GATE_CONTACT_CORRECTION, LINKED customers
    // only (a shared/unknown number could correct the wrong record). Cheap
    // regex prefilter here; only the durable enqueue happens before the
    // ack — the LLM extraction and the writes run in the queue worker,
    // fail-soft, so an error here can never affect inbound SMS handling.
    await fireContactCorrection(smsLogEntry?.id || null);

    // Event-driven health rescore for any matched customer (the opt-out branch
    // above already fired for cancellations). Not gated on messageType: an
    // existing customer texting a churn message to a domain/van tracking number
    // is logged as a *_lead but is still a real customer — fireEventRescore
    // no-ops when there's no matched customer.
    fireEventRescore('inbound_sms');

    await db('activity_log').insert({
      customer_id: customer?.id || null,
      action: messageType === 'inbound' ? 'sms_received' : 'lead_received',
      description: numberConfig.type === 'domain_tracking'
        ? `🌐 Lead from ${numberConfig.domain}: ${From} — "${(Body || '').slice(0, 80)}"`
        : numberConfig.type === 'van_tracking'
          ? `🚛 Lead from van wrap: ${From} — "${(Body || '').slice(0, 80)}"`
          : `📱 SMS from ${customer ? `${customer.first_name} ${customer.last_name}` : From}: "${(Body || '').slice(0, 80)}"`,
      metadata: JSON.stringify({ from: From, to: To, domain: numberConfig.domain }),
    });

    if (Body && !smsReaction) {
      void require('../services/estimate-conversion-agent').processInboundSms({
        customer,
        from: From,
        to: To,
        body: Body,
        smsLogId: smsLogEntry?.id || null,
        sourceMessageId: MessageSid || null,
      }).catch((err) => logger.warn(`[estimate-conversion-agent] async shadow failed: ${err.message}`));
    }

    // Acknowledge Twilio now. Everything below — owner/admin alerts, in-app
    // notifications, the AI auto-reply, and legacy/shadow drafts — is a
    // side-effect that does NOT influence the (always-empty) TwiML reply.
    // Two sequential Claude calls used to run inline here and could exceed
    // Twilio's ~15s webhook timeout, making Twilio retry the webhook (RED
    // audit R2). The inbound message is durably persisted above, so we
    // respond first and finish the rest off the response path. This block
    // carries its own try/catch — its errors can't affect the response.
    res.type('text/xml').send('<Response></Response>');
    setImmediate(() => { void (async () => {
     try {
    const isTrackingLeadInbound = numberConfig.type === 'domain_tracking' || numberConfig.type === 'van_tracking';
    // gbp_tracking is deliberately in this list: a known customer who replies
    // to a GBP tracking number (the number Google shows them) used to skip the
    // sms_reply thread bell entirely and surface only as the legacy
    // "📩 New SMS" dashboard forward — the thread in /admin/communications
    // never rang (observed 2026-07-17, customer texting three Waves numbers).
    const shouldNotifyKnownInbound = numberConfig.type === 'location' || numberConfig.type === 'gbp_tracking' || isTrackingLeadInbound;

    // Reschedule/away flag — customer texts asking to move or miss a visit
    // are invisible to the reminder/en-route automation (2026-08-05: a
    // 12:30am "can we reschedule?" was followed by the visit running and
    // invoicing on schedule). Detect-and-surface only; never mutates the
    // appointment. Fire-and-forget: the flagger is fail-soft internally.
    let rescheduleFlagged = false;
    if (rescheduleFlagResult?.flagged === true && typeof rescheduleFlagResult.fireBell === 'function') {
      // Suppress the generic alert only when the urgent one actually
      // LANDED (bell/push/deliberate suppression).
      rescheduleFlagged = await rescheduleFlagResult.fireBell().catch(() => false);
    }

    // In-app + push notification for inbound SMS from known customers.
    // knownInboundNotified records whether this modern bell/push actually
    // landed — when it did, the legacy owner-SMS forward below is suppressed
    // so a single inbound message can't raise two admin notifications.
    // A landed urgent reschedule alert counts as the admin notification
    // for this message — the legacy owner-SMS forward must not re-alert
    // (codex #3232 r4).
    let knownInboundNotified = rescheduleFlagged;
    if (customer && (Body || inboundMedia.length) && shouldNotifyKnownInbound && !smsReaction && !courtesyOnly && !rescheduleFlagged) {
      try {
        const { triggerNotification } = require('../services/notification-triggers');
        // Re-check right before writing the bell: if the thread was opened
        // (message already read) in the window since the dual-write above,
        // a bell now would outlive its message (hook P1). Fail open — an
        // unknown state still rings.
        const unified = await db('messages').where({ channel: 'sms', twilio_sid: MessageSid }).first('is_read').catch(() => null);
        if (unified?.is_read === true) throw Object.assign(new Error('thread already read'), { alreadyRead: true });
        const bellStartedAt = new Date();
        const stats = await triggerNotification('sms_reply', {
          fromName: `${customer.first_name} ${customer.last_name}`,
          fromPhone: From,
          message: Body || `${inboundMedia.length} photo${inboundMedia.length === 1 ? '' : 's'}`,
          threadId: customer.id,
        });
        // Post-check closes the remaining window (hook P1): if the thread was
        // read while the trigger ran, the bell it just wrote would outlive
        // its message — retire it. Fail open on any lookup error.
        try {
          const after = await db('messages').where({ channel: 'sms', twilio_sid: MessageSid }).first('is_read');
          if (after?.is_read === true) {
            await db('notifications').where({ category: 'inbound_sms' }).whereNull('read_at')
              .where('link', `/admin/communications?thread=${customer.id}`).where('created_at', '>=', bellStartedAt)
              .update({ read_at: new Date() });
          }
        } catch (e) { logger.warn(`[notifications] sms_reply post-check failed: ${e.message}`); }
        // suppressed counts as HANDLED: an internal-test/demo customer's
        // inbound must not fall through to the legacy owner-SMS forward —
        // that would re-create the exact alert the suppression removed.
        knownInboundNotified = Boolean(stats && !stats.error &&
          (stats.suppressed || stats.bellWritten || Number(stats.push?.sent || 0) > 0));
      } catch (e) {
        if (e.alreadyRead) { knownInboundNotified = true; logger.info('[notifications] sms_reply skipped — thread read before the bell'); }
        else logger.error(`[notifications] sms_reply trigger failed: ${e.message}`);
      }
    }

    // Notify Adam of regular inbound SMS. Domain/van tracking leads use the
    // admin notification dispatcher above instead of owner SMS. Skip this
    // legacy owner forward when the sms_reply bell/push above already fired
    // (known customers) — for owner phones it is redirected to the SAME admin
    // notification, so sending both raised a duplicate. Unknown senders have no
    // customer match (sms_reply never fires), so they still get this alert.
    // Per-sender rate limit for UNKNOWN senders: spam robotext threads from
    // one number raised a separate owner alert per message (19 alerts from a
    // single roof-repair thread, 2026-07). One alert per unknown sender per
    // 4h window — the full thread is still in /admin/communications and
    // sms_log. Known customers are unaffected. Fails open on query error.
    //
    // Only rows STRICTLY OLDER than this message's own sms_log row count:
    // two near-simultaneous first texts must not each see the other and both
    // suppress (leaving a new thread with no alert at all) — with a strict
    // created_at ordering, at most the later one suppresses. An exact
    // timestamp tie fails open to two alerts, the safe direction.
    let repeatUnknownSender = false;
    if (!customer && (Body || inboundMedia.length) && smsLogEntry?.created_at) {
      try {
        const prior = await db('sms_log')
          .where({ direction: 'inbound', from_phone: From })
          .where('created_at', '>', new Date(Date.now() - 4 * 60 * 60 * 1000))
          .where('created_at', '<', smsLogEntry.created_at)
          .whereNot('twilio_sid', MessageSid)
          .first('id');
        repeatUnknownSender = Boolean(prior);
      } catch (e) { logger.warn(`[twilio-webhook] repeat-sender check failed: ${e.message}`); }
    }

    if ((Body || inboundMedia.length) && process.env.ADAM_PHONE && !smsReaction && !courtesyOnly && !isTrackingLeadInbound && !knownInboundNotified && !repeatUnknownSender && !(From === process.env.ADAM_PHONE && To === process.env.ADAM_PHONE)) {
      try {
        const senderName = customer ? `${customer.first_name} ${customer.last_name}` : From;
        const mediaText = inboundMedia.length
          ? `\nMedia: ${inboundMedia.length} photo${inboundMedia.length === 1 ? '' : 's'}`
          : '';
        await TwilioService.sendSMS(process.env.ADAM_PHONE,
          `📩 New SMS\nFrom: ${senderName}\n"${(Body || '').slice(0, 120)}"${mediaText}`,
          { messageType: 'internal_alert' }
        );
      } catch (e) { logger.error(`SMS notification failed: ${e.message}`); }
    }

    // Van wrap tracking — new lead flow
    if (numberConfig.type === 'tracking') {
      try {
        const { triggerNotification } = require('../services/notification-triggers');
        await triggerNotification('new_lead', {
          title: 'New lead from van wrap number',
          name: 'Unknown prospect',
          phone: From,
          message: Body || '(no text)',
          source: 'van wrap',
        });
      } catch (e) { logger.error(`Van wrap admin notification failed: ${e.message}`); }
    }

    // WAVES AI ASSISTANT — route through conversational AI engine
    // Only active on the dedicated AI assistant number
    const AI_ASSISTANT_NUMBER = '+18559260203';
    const toClean = (To || '').replace(/\D/g, '');
    const isAiNumber = toClean === '18559260203' || toClean === '8559260203' || To === AI_ASSISTANT_NUMBER;

    let aiAutoReplyOn = false;
    if (isAiNumber) {
      if (isEnabled('aiAssistantAutoReply')) {
        aiAutoReplyOn = true;
      } else {
        try {
          const toggle = await db('system_config').where({ key: 'ai_sms_auto_reply' }).first();
          if (toggle?.value === 'true') aiAutoReplyOn = true;
        } catch { /* ignore */ }
      }
    }
    // Scheduling-intent gate — high-stakes scheduling questions must not be
    // auto-answered. A real failure motivated this: a customer asked "are we
    // on the schedule for tomorrow?" and the canned AI reply said "fully
    // booked, call us" while the customer actually had an appointment. Any
    // scheduling-intent inbound skips the auto-reply entirely and falls
    // through to Virginia's inbox.
    const legacyAiDraftsEnabled = isEnabled('legacyAiDrafts');

    if (Body && (customer || numberConfig.type === 'location') && aiAutoReplyOn && !schedulingIntent && !rescheduleAsk && !smsReaction && !courtesyOnly) {
      try {
        const WavesAssistant = require('../services/ai-assistant/assistant');
        const aiResult = await WavesAssistant.processMessage({
          message: Body,
          channel: 'sms',
          channelIdentifier: From,
          customerId: customer?.id || null,
          customerPhone: From,
        });

        // If AI generated a reply (not escalated), send it automatically
        // through the customer-message middleware. The wrapper enforces
        // suppression (so we don't reply to a STOP'd number), consent,
        // emoji + price-leak rules, and segment cap. Audit row written
        // either way.
        if (aiResult.reply && !aiResult.escalated) {
          try {
            const { sendCustomerMessage } = require('../services/messaging/send-customer-message');
            // Inbound texters always reach at least phone_provided_unverified —
            // they're literally texting from the number, so the channel-level
            // identity is established by the inbound webhook itself. Without
            // this hint, audience='lead' for unknown numbers would fall back
            // to 'anonymous' in the trust resolver and fail the policy
            // minimum for purpose='conversational' (a regression that would
            // silently drop every new-lead AI reply).
            const sendResult = await sendCustomerMessage({
              to: From,
              body: aiResult.reply,
              channel: 'sms',
              audience: customer ? 'customer' : 'lead',
              purpose: 'conversational',
              customerId: customer?.id || null,
              identityTrustLevel: customer ? 'phone_matches_customer' : 'phone_provided_unverified',
              entryPoint: 'twilio_inbound_ai_assistant',
              // Send-window inbound-reply provenance: this reply answers the
              // SMS the customer sent seconds ago — the one send class the
              // window deliberately never defers.
              conversationalContext: true,
              metadata: { fromNumber: To },
            });
            if (!sendResult.sent) {
              // PII rule: never log full phone in plaintext. Mask to last 4
              // digits — enough for operator debugging via audit log
              // cross-reference. Drop sendResult.reason: upstream
              // provider/guard error strings may include the full
              // recipient phone or message body. Operators get the full
              // failure context via messaging_audit_log keyed by code +
              // to_last4.
              const last4 = String(From || '').replace(/\D/g, '').slice(-4);
              logger.warn(`[twilio-webhook] AI reply BLOCKED for ***${last4}: code=${sendResult.code}`);

              // Transient provider failure (Twilio 429/5xx/timeout): don't
              // silently drop the reply. Re-queue it onto the scheduled-SMS
              // rail so the every-5-min cron retries it, bounded by
              // SCHEDULED_SMS_MAX_ATTEMPTS. message_type maps to purpose
              // 'conversational', matching the inbound send above. (RED R3)
              if (sendResult.retryable && sendResult.nextAllowedAt) {
                try {
                  await db('sms_log').insert({
                    customer_id: customer?.id || null,
                    direction: 'outbound',
                    from_phone: To,
                    to_phone: From,
                    message_body: aiResult.reply,
                    status: 'scheduled',
                    scheduled_for: new Date(sendResult.nextAllowedAt),
                    message_type: 'ai_assistant_reply',
                    metadata: JSON.stringify({
                      entry_point: 'twilio_inbound_ai_assistant_retry',
                      provider_retry: true,
                      original_failure_code: sendResult.code || null,
                      // The retry is still an answer to the customer's own
                      // inbound text — the executor restores the send-window
                      // inbound-reply exemption from this flag.
                      conversational_context: true,
                    }),
                  });
                  logger.info(`[twilio-webhook] AI reply re-queued (retry at ${sendResult.nextAllowedAt}) for ***${last4}`);
                } catch (requeueErr) {
                  logger.error(`[twilio-webhook] AI reply re-queue failed: ${requeueErr.message}`);
                }
              }
            }
          } catch (e) { logger.error(`AI reply SMS failed: ${e.message}`); }
        }

        logger.info(`AI Assistant processed: ${From} escalated=${aiResult.escalated} conv=${aiResult.conversationId}`);
      } catch (e) { logger.error(`AI Assistant failed: ${e.message}`); }
    } else if ((schedulingIntent || rescheduleAsk) && aiAutoReplyOn) {
      // Log the intentional skip so we can audit the gate and see volume.
      logger.info('[sms-intent] scheduling-intent detected; skipping auto-reply, routing to human inbox');
    } else if (smsReaction && aiAutoReplyOn) {
      logger.info('[sms-intent] SMS reaction detected; skipping auto-reply');
    } else if (courtesyOnly && aiAutoReplyOn) {
      logger.info('[sms-intent] courtesy-only closer; skipping auto-reply');
    }

    // LEGACY AI DRAFT — still create drafts for admin review alongside the AI assistant
    if (customer && numberConfig.type === 'location' && Body && legacyAiDraftsEnabled && !schedulingIntent && !rescheduleAsk && !smsReaction && !courtesyOnly) {
      try {
        const ContextAggregator = require('../services/context-aggregator');
        const ResponseDrafter = require('../services/response-drafter');

        const context = await ContextAggregator.getFullCustomerContext(From);

        // Simple intent classification
        const intentMap = [
          { pattern: /when|next|schedule|appointment/i, intent: 'SCHEDULE_INQUIRY' },
          { pattern: /cancel|stop|pause|quit/i, intent: 'CANCEL_REQUEST' },
          { pattern: /bug|ant|roach|spider|pest|rat|mouse|termite|mosquito/i, intent: 'PEST_REPORT' },
          { pattern: /bill|pay|charge|invoice|balance/i, intent: 'BILLING_INQUIRY' },
          { pattern: /complain|unhappy|frustrated|not working|still seeing/i, intent: 'COMPLAINT' },
          { pattern: /thank|great|awesome|perfect|love|excellent/i, intent: 'POSITIVE_FEEDBACK' },
          { pattern: /yes|confirm|ok|sounds good/i, intent: 'CONFIRMATION' },
        ];
        const matched = intentMap.find(m => m.pattern.test(Body));
        const intent = { intent: matched?.intent || 'GENERAL', confidence: matched ? 0.85 : 0.5 };

        const draft = await ResponseDrafter.draftResponse(Body, context, intent);

        // Store draft for approval — DO NOT send
        await db('message_drafts').insert({
          sms_log_id: smsLogEntry?.id || null,
          customer_id: customer.id,
          inbound_message: Body,
          draft_response: draft.draft,
          intent: intent.intent,
          intent_confidence: intent.confidence,
          context_summary: context.summary,
          flags: JSON.stringify(context.flags),
          status: 'pending',
        });

        // Auto-suggest appointment for schedule inquiries
        if (intent.intent === 'SCHEDULE_INQUIRY' && customer) {
          try {
            // Find next available slot based on customer location
            const zone = customer.city ? require('../config/locations').resolveLocation(customer.city) : null;
            const tomorrow = new Date();
            tomorrow.setDate(tomorrow.getDate() + 1);
            const nextWeek = new Date();
            nextWeek.setDate(nextWeek.getDate() + 7);

            // Check scheduled service load for next 7 days
            const dailyLoad = await db('scheduled_services')
              .whereBetween('scheduled_date', [tomorrow.toISOString().split('T')[0], nextWeek.toISOString().split('T')[0]])
              .whereNotIn('status', ['cancelled'])
              .select('scheduled_date')
              .count('* as count')
              .groupBy('scheduled_date')
              .orderBy('count', 'asc');

            // Find the lightest day
            const lightestDay = dailyLoad[0]?.scheduled_date || tomorrow.toISOString().split('T')[0];
            const datePretty = new Date(lightestDay + 'T12:00:00').toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric', timeZone: 'America/New_York' });

            // Append suggestion to the draft
            draft.draft += `\n\nI can get you scheduled for ${datePretty} — morning or afternoon works better for you?`;

            logger.info(`[sms-intent] Schedule inquiry from ${customer.first_name} — suggesting ${datePretty}`);
          } catch (schedErr) {
            logger.error(`[sms-intent] Schedule suggestion failed: ${schedErr.message}`);
          }
        }

        // Notify Adam for high-urgency
        if (['COMPLAINT', 'CANCEL_REQUEST', 'SCHEDULE_INQUIRY'].includes(intent.intent)) {
          try {
            await TwilioService.sendSMS(ADMIN_ALERT_PHONE,
              `📱 ${customer.first_name}: "${Body.slice(0, 80)}"\n🤖 Draft: "${draft.draft.slice(0, 80)}..."\nApprove: ${publicPortalUrl()}/admin/communications`,
              { messageType: 'internal_alert' }
            );
          } catch (e) { logger.error(`Draft alert failed: ${e.message}`); }
        }

        logger.info(`AI draft created for ${customer.first_name}: ${intent.intent}`);
      } catch (e) { logger.error(`AI draft pipeline failed: ${e.message}`); }
    } else if (customer && numberConfig.type === 'location' && Body && !legacyAiDraftsEnabled) {
      logger.info('[sms-intent] legacy AI draft gate disabled; skipping draft creation');
    } else if (customer && numberConfig.type === 'location' && Body && (schedulingIntent || rescheduleAsk)) {
      logger.info('[sms-intent] scheduling-intent detected; skipping legacy AI draft');
    } else if (customer && numberConfig.type === 'location' && Body && smsReaction) {
      logger.info('[sms-intent] SMS reaction detected; skipping legacy AI draft');
    }

    // SMS SHADOW DRAFTER (brand-voice loop, Phase B) — silently record what
    // the house-voice AI would have replied. status='shadow' rows never send
    // and never enter the approval queue; a later judge pass scores them
    // against the reply Virginia actually sent. The AI number is excluded
    // (findByNumber reports it as type 'location', but its traffic is
    // already AI-handled — there is no human reply to judge against).
    // Scheduling-intent messages ARE shadowed: a shadow row can't send, and
    // the high-stakes class is exactly where the judge needs data.
    if (Body && customer && !smsReaction && !isAiNumber && numberConfig.type === 'location' && isEnabled('smsShadowDrafts')) {
      try {
        const { classifyCustomerSmsTriageIntent } = require('../services/estimate-conversion-agent');
        // no_reply_needed messages are shadowed too (intent label kept):
        // short confirmations like "yes" / "sounds good" classify that way
        // from the body alone, but they're exactly where a human follows up
        // — and knowing when NOT to reply is itself a judged class. The
        // draft contract allows an empty reply for true courtesy acks.
        const triage = classifyCustomerSmsTriageIntent(Body, { customer });
        void require('../services/sms-shadow-drafter').draftShadowReply({
          inboundMessage: Body,
          fromPhone: From,
          customer,
          smsLogId: smsLogEntry?.id || null,
          intent: triage,
          schedulingIntent,
        }).catch((err) => logger.warn(`[sms-shadow] async draft failed: ${err.message}`));
      } catch (e) { logger.error(`[sms-shadow] wiring failed: ${e.message}`); }
    }

     } catch (sideErr) {
       logger.error(`[twilio-webhook] async inbound side-effects failed: ${sideErr.message}`);
     }
    })(); });
    // Response already sent above (empty TwiML — Adam approves drafts before sending).
  } catch (err) {
    logger.error(`Webhook error: ${err.message}`);
    // Release the idempotency claim ONLY if this delivery owns it AND nothing
    // non-idempotent has committed yet (!persisted): handling failed before the
    // inbound row landed, so a Twilio retry SHOULD reprocess rather than be
    // short-circuited as a duplicate. A fail-open delivery (claimOwned=false)
    // must NOT release — it never took the row, and deleting it would free a
    // sibling delivery's good claim. Once persisted, we keep the claim so a
    // retry can't duplicate sms_log. (The deferred side-effects run after the
    // response with their own catch — they
    // never reach here, so a post-ack failure correctly keeps the claim.)
    if (claimOwned && !persisted) void releaseInboundWebhook(req.body?.MessageSid);
    notifyTwilioFailure({
      channel: 'sms',
      direction: 'inbound',
      phase: 'webhook',
      status: 'failed',
      sid: req.body?.MessageSid,
      errorMessage: err.message,
      from: req.body?.From,
      to: req.body?.To,
      link: '/admin/communications',
    });
    res.type('text/xml').send('<Response></Response>');
  } finally {
    // Release an un-run correction reservation on every exit path — a
    // branch that fired keeps its row (correctionFired is set
    // synchronously before its first await); everything else must not
    // leave the sender's queue position held until the worker's stale
    // sweep. cancel() only touches rows still 'reserved', so already
    // enqueued or already cancelled jobs are unaffected.
    if (correctionJobId && !correctionFired) {
      void require('../services/contact-correction-queue')
        .cancelContactCorrectionJob(correctionJobId, 'route_exit');
    }
  }
});

// POST /api/webhooks/twilio/status — delivery status callback
router.post('/status', async (req, res) => {
  try {
    const { MessageSid, MessageStatus, ErrorCode, ErrorMessage, From, To } = req.body;
    if (MessageSid && MessageStatus) {
      // Bookkeeping is isolated: a transient DB error here must not jump to
      // the outer catch and skip the bounce-remediation handlers below —
      // the webhook answers 200 regardless, so Twilio would never redeliver
      // and a bounce would be lost (codex P2).
      try {
        await db('sms_log').where({ twilio_sid: MessageSid }).update({ status: MessageStatus });
        await updateByTwilioSid(MessageSid, { delivery_status: MessageStatus, updated_at: new Date() });
      } catch (bookkeepingErr) {
        logger.error(`[twilio-status] status bookkeeping failed (continuing to handlers): ${bookkeepingErr.message}`);
      }
      if (isFailureStatus(MessageStatus)) {
        notifyTwilioFailure({
          channel: 'sms',
          direction: 'outbound',
          phase: 'delivery',
          status: MessageStatus,
          sid: MessageSid,
          errorCode: ErrorCode,
          errorMessage: ErrorMessage,
          from: From,
          to: To,
          link: '/admin/communications',
        });

        // Error 21610 — the RECIPIENT's carrier-level opt-out verdict for a
        // STOP we never saw inbound (sent to a different number on the
        // Messaging Service, a pre-portal opt-out, a carrier block). Without
        // this branch the number stays textable on every surface and every
        // lane keeps burning sends against it forever. Feed the canonical
        // suppression store + flip prefs, mirroring the inbound STOP handler
        // above; fail LOUD — a swallowed write means other workflows keep
        // texting an opted-out number.
        //
        // CONCURRENCY (codex #3495 rounds 1-10): the whole flow runs in ONE
        // transaction under a per-phone advisory lock, so competing 21610
        // callbacks (older send A vs newer send B) fully serialize — every
        // callback runs THIS code, so the lock closes A-vs-B. The START
        // handler orders via log-then-clear: its inbound sms_log row lands
        // before its clearSuppression, so either our upsert precedes the
        // clear (START removes it) or our post-write recheck sees the
        // logged START and undoes inside the same transaction. Ordering
        // between callbacks uses the source token twilio_status_21610:<sid>
        // — an older callback defers when the standing row's author has the
        // newer send. All bells/logs fire post-commit.
        if (String(ErrorCode) === '21610') {
          const optOutPhone = normalizeE164(To) || To;
          const suppressionSource = `twilio_status_21610:${MessageSid}`;
          const outcome = {};
          try {
            await db.transaction(async (trx) => {
              await trx.raw("SELECT pg_advisory_xact_lock(hashtext('twilio_21610'), hashtext(?::text))", [optOutPhone]);
              let logRow = await trx('sms_log').where({ twilio_sid: MessageSid }).first('customer_id', 'created_at', 'metadata');
              // Retry the SID association briefly (codex #3495 r16): a fast
              // callback can race a LEGACY writer's post-handoff log insert
              // (the primary path logs pre-handoff, so its row is always
              // visible). A few short waits usually see the racing insert
              // commit and give this callback its real send time.
              for (let attempt = 0; !logRow && attempt < 3; attempt++) {
                await new Promise((resolve) => setTimeout(resolve, 300));
                logRow = await trx('sms_log').where({ twilio_sid: MessageSid }).first('customer_id', 'created_at', 'metadata');
              }
              const sentAt = logRow?.created_at || null;
              // The primary send path stamps created_at PRE-handoff and
              // marks the row (metadata.pre_handoff_stamp) — those rows
              // need NO grace, and backdating them misorders a START at T
              // against a genuinely-later send at T+3s (hook P1). Legacy
              // writers still log after messages.create() returns, so
              // UNSTAMPED rows keep the seconds-scale shave: a clearance
              // inside that window keeps winning, and the recheck below
              // scans the same widened window so a raced START is seen.
              // Self-healing either way: the next send bounces with a
              // clearly-newer sentAt, and the d18 reconciler backstops.
              const SEND_RACE_GRACE_MS = 5 * 1000;
              const { hasPreHandoffStamp } = require('../services/messaging/suppression-ownership');
              const sentAtFloor = sentAt
                ? new Date(new Date(sentAt).getTime() - (hasPreHandoffStamp(logRow) ? 0 : SEND_RACE_GRACE_MS))
                : null;
              const optOutCustomerId = logRow?.customer_id || null;
              const supRow = await trx('messaging_suppression')
                .where({ phone: optOutPhone }).forUpdate().first('active', 'cleared_at', 'source');
              // A clearance newer than this send wins (late/redelivered
              // callback after a START). A callback STILL undated after the
              // retries (racing writer never committed) defers only to a
              // RECENT clearance — one inside the same 10-minute window the
              // recheck below assumes for a raced send, which could
              // genuinely postdate it. An OLDER tombstone provably predates
              // this near-real-time callback's send: deferring to it would
              // discard the carrier's CURRENT opt-out and leave the phone
              // textable on every lane (codex #3495 r16). A late-redelivered
              // callback for a genuinely old send has a long-committed log
              // row and never reaches this fallback. With no clearance at
              // all, an undated callback still applies the opt-out (fail
              // toward not texting).
              const undatedSendFloor = new Date(Date.now() - 10 * 60 * 1000);
              if (supRow && supRow.active === false && supRow.cleared_at
                  && new Date(supRow.cleared_at) > (sentAtFloor || undatedSendFloor)) {
                outcome.deferred = 'cleared-after-send'; return;
              }
              // A standing row authored by a NEWER attempt owns the verdict
              // — an older callback must not overwrite it. The shared
              // reader also orders against SYNC-authored rows (codex #3495
              // r14: 'twilio_send_21610:<iso>' embeds the attempt time).
              const ownerAt = await require('../services/messaging/suppression-ownership')
                .standingVerdictTime(supRow, { dbh: trx, excludeSid: MessageSid });
              // An UNDATED callback (no sms_log row) cannot supersede a
              // TIMESTAMPED standing owner either (hook P1) — same rule as
              // the clearance check above: without its own send time this
              // callback cannot prove it is newer, and proceeding would let
              // its recheck clear the newer verdict via an intervening
              // START. Defer keeps the phone suppressed — the safe side.
              // Ordered against the ADJUSTED send time (hook #3495 r16):
              // an unstamped legacy row logged AFTER a newer send's verdict
              // must not read as newer than that owner — comparing raw
              // sentAt would let the older attempt overwrite the newest
              // carrier verdict and its recheck clear it via a raced START.
              if (ownerAt && (!sentAtFloor || ownerAt > sentAtFloor)) {
                outcome.deferred = 'newer-callback-owns-row'; return;
              }
              // recordSuppression resolves { ok: false } on a swallowed DB
              // error — check the result; a throw here rolls everything back.
              const result = await recordSuppression({
                phone: optOutPhone, reason: 'opt_out', source: suppressionSource, dbh: trx,
              });
              if (result?.ok === false) {
                throw Object.assign(new Error('suppression write reported failure'), { code: 'suppression_write_failed' });
              }
              // Post-write recheck: the NEWEST post-send opt command wins.
              // No SQL vocabulary mirror (codex #3495: a hand-built regex
              // superset drifts from detectSmsOptCommand's patterns — it
              // already missed phrase forms like "please take me off").
              // The detector is the SOLE authority: scan the newest 200
              // post-send inbound rows and classify in JS. If no command
              // appears among them, the suppression STANDS — an opt-in
              // older than 200 newer messages cannot be trusted to be the
              // newest verdict, and failing toward not texting is the safe
              // side of that uncertainty.
              let laterOptIn = false;
              {
                // Runs even when the callback raced the outbound log insert
                // (no sms_log row yet ⇒ sentAt null): the send happened
                // seconds ago, so scan the last few minutes — a concurrent
                // START that logged-and-cleared before this upsert is seen
                // and undone in this same transaction instead of being
                // overwritten (codex r7 P1). An older START outside that
                // window still cannot resurrect over the carrier's verdict.
                const scanFloor = sentAtFloor || new Date(Date.now() - 10 * 60 * 1000);
                const inbound = await trx('sms_log')
                  .where({ from_phone: optOutPhone })
                  .where('created_at', '>', scanFloor)
                  .orderBy('created_at', 'desc')
                  .limit(200)
                  .select('message_body');
                const newestCommand = inbound
                  .map((r) => detectSmsOptCommand(r.message_body || '').action)
                  .find((a) => a === 'opt_in' || a === 'opt_out');
                laterOptIn = newestCommand === 'opt_in';
              }
              if (laterOptIn) {
                // Undo our own write in the same transaction; a failed clear
                // throws so the upsert rolls back too — never commit a
                // suppression the recipient has already opted back out of.
                const cleared = await clearSuppression({
                  phone: optOutPhone, source: 'twilio_status_21610_late_callback_undo', dbh: trx,
                });
                if (cleared?.ok === false) {
                  throw Object.assign(new Error('clearSuppression reported failure'), { code: 'suppression_clear_failed' });
                }
                outcome.undone = true; return;
              }
              // Verdicts. A 21610 on the opt-in ask records the recipient as
              // DECLINED (same as inbound STOP) — the generic ask_failed
              // state is one markRecipientOptin('confirmed') ignores, which
              // would leave fanout blocked after a later START cleared the
              // suppression. Returns a row count on success (0 = no
              // recipient asks, the common case) and FALSE on a swallowed
              // DB error.
              // markRecipientOptin swallows SQL errors and returns FALSE —
              // but a swallowed SQL error has already ABORTED this Postgres
              // transaction, and Knex can resolve the eventual COMMIT that
              // Postgres converts to ROLLBACK, reporting success while the
              // suppression vanished (hook r12 P1). The phone is valid here
              // (normalized above), so FALSE ≡ SQL error: throw, roll back
              // cleanly, and let the generic failure bell fire. The normal
              // no-recipient-rows case returns the number 0 and proceeds.
              const declined = await require('../services/recipient-optin').markRecipientOptin(optOutPhone, 'declined', { dbh: trx });
              if (declined === false) {
                throw Object.assign(new Error('recipient decline write reported failure'), { code: 'recipient_decline_failed' });
              }
              // Prefs flip — the suppression row is the enforcement;
              // sms_enabled keeps the admin UI honest (same split as STOP).
              // Guarded to the ACCOUNT HOLDER's own phone (codex #3495): an
              // appointment SMS to a spouse/tenant/service contact carries
              // the property's customer_id in sms_log, and that contact's
              // carrier opt-out must not flip the account holder's prefs —
              // the phone-keyed suppression row already blocks the contact.
              if (optOutCustomerId) {
                const owner = await trx('customers').where({ id: optOutCustomerId }).first('phone');
                const ownerPhone = normalizeE164(owner?.phone || '');
                if (ownerPhone && ownerPhone === optOutPhone) {
                  await trx('notification_prefs')
                    .insert({ customer_id: optOutCustomerId, sms_enabled: false })
                    .onConflict('customer_id')
                    .merge({ sms_enabled: false });
                }
              } else {
                // Early callback raced the sms_log insert (Twilio can reject
                // at send time, before our row commits) — the SID lookup
                // found nothing, so resolve the holder by primary-phone
                // OWNERSHIP instead (codex r5 P2). Same guard semantics: a
                // customer whose OWN phone carrier-opted-out gets an honest
                // sms_enabled=false; a contact's number that isn't anyone's
                // primary phone flips nothing (the phone-keyed suppression
                // row above already blocks it either way).
                const ownDigits = String(optOutPhone).replace(/\D/g, '').slice(-10);
                if (ownDigits.length === 10) {
                  const holders = await trx('customers')
                    .whereRaw("regexp_replace(COALESCE(phone, ''), '[^0-9]', '', 'g') LIKE ?", [`%${ownDigits}`])
                    .whereNull('deleted_at')
                    .select('id');
                  // UNIQUE ownership only (codex r8 P2): a later START's
                  // prefs restore goes through findSingleCustomerByPhone,
                  // which refuses ambiguous numbers — flipping every
                  // sharer here would be irreversible for all of them.
                  // Ambiguous ⇒ skip the flip; the phone-keyed suppression
                  // row still blocks sends, and the d18 daily reconciler
                  // surfaces the prefs-vs-suppression drift.
                  if (holders.length === 1) {
                    await trx('notification_prefs')
                      .insert({ customer_id: holders[0].id, sms_enabled: false })
                      .onConflict('customer_id')
                      .merge({ sms_enabled: false });
                  }
                }
              }
              outcome.applied = true;
            });
          } catch (suppressErr) {
            outcome.failed = suppressErr.code || suppressErr.name || 'db_error';
          }
          // ── Post-commit reporting (never inside the transaction) ──
          // failed wins over any flag set inside the callback: a COMMIT
          // rejection lands in the catch AFTER applied/undone were set, and
          // nothing persisted (hook r11 P1).
          if (outcome.failed) {
            logger.warn(`[twilio-status] 21610 opt-out handling FAILED for ${maskPhone(optOutPhone)}: ${outcome.failed}`);
            try {
              await require('../services/notification-service').notifyAdmin(
                'system',
                'Opt-out suppression write failed',
                `A Twilio 21610 opt-out for ${maskPhone(optOutPhone)} could not be recorded (delivery status callback; ${outcome.failed}). Add this number to the do-not-text list manually — other SMS workflows cannot see the opt-out until it is recorded.`,
                { bell: true, metadata: { source: 'twilio_status_21610', error: outcome.failed } },
              );
            } catch (notifyErr) {
              logger.error(`[twilio-status] 21610 failure notify also failed: ${notifyErr.message}`);
            }
          } else if (outcome.applied) {
            logger.info(`[twilio-status] 21610 provider opt-out recorded for ${maskPhone(optOutPhone)}`);
          } else if (outcome.undone) {
            // Best-effort line-type cache drop mirrors clearSuppression's
            // follow-up (it ran with dbh=trx; the cache del is idempotent).
            logger.info(`[twilio-status] 21610 for ${maskPhone(optOutPhone)} superseded by a later inbound opt-in — suppression not kept`);
          } else if (outcome.deferred) {
            logger.info(`[twilio-status] 21610 for ${maskPhone(optOutPhone)} deferred (${outcome.deferred})`);
          }
        }

        // Appointment-text fallback: if this undelivered message was an appointment
        // notification (confirmation / 72h / 24h / en-route), learn the landline on
        // a 30006 bounce and send the email version so the customer still gets it.
        // Best-effort, off the webhook response path — never block the 200.
        try {
          const AppointmentReminders = require('../services/appointment-reminders');
          void AppointmentReminders.handleUndeliveredSms({
            sid: MessageSid,
            status: MessageStatus,
            errorCode: ErrorCode,
            to: To,
          }).catch((e) => logger.error(`[twilio-status] appointment email fallback failed: ${e.message}`));
        } catch (e) {
          logger.error(`[twilio-status] appointment email fallback dispatch failed: ${e.message}`);
        }

        // Recipient double opt-in: a failed/undelivered confirmation ask
        // flips its pending row to ask_failed so the next consented save
        // retries — otherwise the recipient sits pending forever without
        // ever having received the YES request. Best-effort, keyed on the
        // undelivered number (rows are per customer+phone; all pending
        // rows for the number failed the same delivery).
        try {
          const { recipientPhoneKey } = require('../services/recipient-optin');
          const failedKey = recipientPhoneKey(To);
          if (failedKey) {
            // Only when THIS undelivered message was the opt-in ask itself —
            // an unrelated failed text to the same number must not flip a
            // possibly-delivered ask to ask_failed.
            void db('sms_log').where({ twilio_sid: MessageSid }).first()
              .then((logRow) => {
                const meta = typeof logRow?.metadata === 'string'
                  ? logRow.metadata
                  : JSON.stringify(logRow?.metadata || {});
                const isOptinAsk = logRow
                  && (logRow.message_type === 'recipient_optin_request'
                    || meta.includes('recipient_optin_request'));
                // Strict SID match in BOTH paths: only the row whose CURRENT
                // dispatch is this MessageSid flips — a delayed/duplicated
                // callback for an old SID can't hit a reclaimed in-flight
                // ask. A row whose marker/SID write failed entirely stays
                // pending and is reconciled by the recovery sweep (its
                // sms_log status is failed → the sweep re-dispatches).
                if (isOptinAsk && logRow.customer_id) {
                  // Strict SID match, with one carve-out for the race where
                  // the callback lands before provider_sid is stamped: a
                  // null-SID pending row flips only when this log row's ask
                  // was created AFTER the row's claim (it IS this claim's
                  // ask — an old SID's ask predates a reclaimed row's
                  // requested_at and cannot match).
                  return db('recipient_optin')
                    .where({ phone_key: failedKey, customer_id: logRow.customer_id, status: 'pending' })
                    .where(function sidOrRace() {
                      this.where({ provider_sid: MessageSid })
                        .orWhere(function raced() {
                          this.whereNull('provider_sid');
                          if (logRow.created_at) this.where('requested_at', '<=', logRow.created_at);
                        });
                    })
                    .update({ status: 'ask_failed', updated_at: new Date() });
                }
                return db('recipient_optin')
                  .where({ provider_sid: MessageSid, status: 'pending' })
                  .update({ status: 'ask_failed', updated_at: new Date() })
                  .then((flipped) => {
                    // Callback raced BOTH the sms_log insert and the SID
                    // stamp: nothing matched now, but both writes land within
                    // seconds — retry once after 60s (best-effort; the
                    // sweep's failed-ask pass is the durable backstop).
                    if (!flipped && !logRow) {
                      setTimeout(() => {
                        void db('sms_log').where({ twilio_sid: MessageSid }).first()
                          .then((lateRow) => {
                            if (!lateRow) return null;
                            const lateMeta = typeof lateRow.metadata === 'string' ? lateRow.metadata : JSON.stringify(lateRow.metadata || {});
                            const lateOptin = lateRow.message_type === 'recipient_optin_request' || lateMeta.includes('recipient_optin_request');
                            if (!lateOptin || !lateRow.customer_id) return null;
                            return db('recipient_optin')
                              .where({ phone_key: failedKey, customer_id: lateRow.customer_id, status: 'pending' })
                              .update({ status: 'ask_failed', updated_at: new Date() });
                          })
                          .catch(() => {});
                      }, 60 * 1000);
                    }
                    return flipped;
                  });
              })
              .catch(() => {});
          }
        } catch { /* best-effort */ }

        // Channel-agnostic landline learning: a carrier 30006 ("landline or
        // unreachable carrier") means this number can't receive ANY SMS. Suppress
        // it so every automated path (invoice dunning, review requests, …) stops
        // texting it — not just the appointment path's line_type cache. Best-effort,
        // off the 200 response path; never throws.
        try {
          const { suppressNonMobileOnBounce } = require('../services/messaging/landline-suppression');
          void suppressNonMobileOnBounce({
            sid: MessageSid,
            status: MessageStatus,
            errorCode: ErrorCode,
            to: To,
          }).catch((e) => logger.error(`[twilio-status] landline suppression failed: ${e.message}`));
        } catch (e) {
          logger.error(`[twilio-status] landline suppression dispatch failed: ${e.message}`);
        }

        // Voicemail text-back bounce: the quote link never arrived (30006
        // landline is the common case), so the lead has had NO first contact
        // and nothing else surfaces that. Pull its follow-up to now and leave
        // a call-instead breadcrumb on the lead timeline. Best-effort, off
        // the 200 response path.
        try {
          const VoicemailLeadSms = require('../services/voicemail-lead-sms');
          void VoicemailLeadSms.handleUndeliveredQuoteLink({
            sid: MessageSid,
            status: MessageStatus,
            errorCode: ErrorCode,
            to: To,
          }).catch((e) => logger.error(`[twilio-status] voicemail quote-link bounce handling failed: ${e.message}`));
        } catch (e) {
          logger.error(`[twilio-status] voicemail quote-link bounce dispatch failed: ${e.message}`);
        }

        // Dropped-call address-request bounce: same failure mode as the
        // voicemail quote link — Twilio accepted at send time, the carrier
        // bounced later (30006 landline past the fail-open pre-check), and
        // the lead + review card still say "sent, watch for a reply" that
        // can never come. The handler stamps the lead, pulls its follow-up
        // to now, and flips the open card to 'undelivered'.
        try {
          const DroppedCallSms = require('../services/dropped-call-sms');
          void DroppedCallSms.handleUndeliveredAddressRequestWithRetry({
            sid: MessageSid,
            status: MessageStatus,
            errorCode: ErrorCode,
            to: To,
          }).catch((e) => logger.error(`[twilio-status] dropped-call address-request bounce handling failed: ${e.message}`));
        } catch (e) {
          logger.error(`[twilio-status] dropped-call address-request bounce dispatch failed: ${e.message}`);
        }
      }
    }
  } catch (err) {
    logger.error(`Status webhook error: ${err.message}`);
    notifyTwilioFailure({
      channel: 'sms',
      direction: 'outbound',
      phase: 'status_webhook',
      status: 'failed',
      sid: req.body?.MessageSid,
      errorMessage: err.message,
      from: req.body?.From,
      to: req.body?.To,
      link: '/admin/communications',
    });
  }
  res.sendStatus(200);
});

// Gate check FIRST (codex #3413 r55): with GATE_CONTACT_CORRECTION off —
// the kill-switch state — the lane must not add awaited DB work or persist
// duplicate SMS/PII on the webhook path at all; the worker-side gate_off
// outcome is the backstop, not the boundary.
/**
 * Did the most recent customer-facing outbound from OUR receiving number to
 * this phone (last 24h) end on a question? Internal alerts are excluded. Fail CLOSED: any error or no
 * recent outbound → true, so a bare "👍" stays loud when in doubt.
 */
async function lastOutboundAskedQuestion(toPhone, ourNumber) {
  try {
    // Scoped to the Waves number the customer replied on: a question asked
    // from a different line is a different thread (hook P1).
    const last = await db('sms_log')
      .where({ direction: 'outbound', to_phone: toPhone, from_phone: ourNumber })
      .whereIn('status', ['queued', 'sent', 'delivered']) // a failed/blocked send never reached them (hook P1)
      .where(function notInternal() { this.whereNot('message_type', 'internal_alert').orWhereNull('message_type'); })
      .where('created_at', '>', new Date(Date.now() - 24 * 60 * 60 * 1000))
      .orderBy('created_at', 'desc')
      .first('message_body');
    if (!last) return true;
    // A question mark OR an explicit reply directive ("Reply YES to confirm",
    // "let us know", "text back") — templates ask without "?" (hook P1).
    return /\?|\breply\b|\brespond\b|\btext\s+(?:us\s+)?back\b|\blet\s+(?:us|me)\s+know\b|\bconfirm\b/i.test(String(last.message_body || ''));
  } catch (e) {
    logger.warn(`[twilio-webhook] awaiting-answer lookup failed: ${e.message}; treating as awaiting`);
    return true;
  }
}

function shouldReserveCorrectionJob(body, smsReaction) {
  return Boolean(body && !smsReaction
    && require('../config/feature-gates').isEnabled('contactCorrection')
    && require('../services/contact-correction').detectContactCorrectionIntent(body));
}

router._internals = {
  extractContactNameFromSms,
  intakeOutcome,
  shouldReserveCorrectionJob,
};

module.exports = router;
