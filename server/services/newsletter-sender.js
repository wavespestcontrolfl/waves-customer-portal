/**
 * Newsletter send service — shared by the admin "Send now" route and the
 * scheduler tick that picks up scheduled sends. Segment filtering and A/B
 * subject assignment live here so both callers get identical behavior.
 *
 * Segment filter shape (stored in newsletter_sends.segment_filter jsonb):
 *   { sources?: string[], tags?: string[], customersOnly?: boolean,
 *     leadsOnly?: boolean }
 *   null/undefined = all active subscribers (legacy behavior)
 */

const db = require('../models/db');
const sendgrid = require('./sendgrid-mail');
const logger = require('./logger');
const crypto = require('crypto');
const { wrapNewsletter, ensureLegalTextFooter } = require('./email-template');
const { recordTouchpoint } = require('./conversations');
const { GREETING_NAME_TOKEN, greetingNameValueFor } = require('./newsletter-draft');

function stripHtml(html) {
  if (!html) return '';
  return html.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
}

// Suppression types that block delivery on EVERY send stream, mirroring
// activeSuppressionFor() in email-template-library.js. Bounces stay GLOBAL by
// design (email audit C4), so the newsletter blast must honor them too.
const GLOBAL_SUPPRESSION_TYPES = ['bounce', 'spam_complaint', 'do_not_email'];

// Exclude any address with an active GLOBAL suppression (bounce /
// spam_complaint / do_not_email) recorded via ANY stream — mirrors
// activeSuppressionFor() so the newsletter blast can't re-mail addresses every
// other send path already blocks. The correlated subquery references
// newsletter_subscribers.email, so this must be applied to a query that has
// that table in scope (segment build, recipient count, AND the resume/retry
// refetch — the resume path does NOT go through buildSubscriberQuery, so it
// must call this helper directly).
function excludeGloballySuppressed(query) {
  return query.whereNotExists(function () {
    this.select(db.raw('1'))
      .from('email_suppressions as es')
      .where('es.status', 'active')
      .whereRaw('LOWER(es.email) = LOWER(newsletter_subscribers.email)')
      .whereRaw('LOWER(es.suppression_type) IN (?, ?, ?)', GLOBAL_SUPPRESSION_TYPES);
  });
}

function buildSubscriberQuery(segmentFilter) {
  let q = excludeGloballySuppressed(db('newsletter_subscribers').where({ status: 'active' }));
  if (!segmentFilter) return q;

  const f = segmentFilter;
  if (Array.isArray(f.sources) && f.sources.length) q = q.whereIn('source', f.sources);
  if (f.customersOnly) q = q.whereNotNull('customer_id');
  if (f.leadsOnly) q = q.whereNull('customer_id');
  if (Array.isArray(f.tags) && f.tags.length) {
    q = q.whereRaw('tags \\?| array[' + f.tags.map(() => '?').join(',') + ']', f.tags);
  }
  return q;
}

function assignAbVariant() {
  return Math.random() < 0.5 ? 'a' : 'b';
}

// SendGrid event webhooks echo this set back verbatim per recipient. The
// newsletter handler in webhooks-sendgrid.js falls back to matching on
// custom_args.delivery_id when the X-Message-Id-based lookup fails, which
// covers the "we lost the SendGrid response but they actually queued the
// batch" case. Without this, those rows stay 'failed' forever and an
// operator-triggered resume would double-send.
const TERMINAL_SUCCESS_STATUSES = ['sent', 'delivered', 'opened', 'clicked'];
const RETRYABLE_DELIVERY_STATUSES = ['queued', 'failed', 'sending'];

function isRetryableDelivery(delivery) {
  if (!delivery) return false;
  const status = String(delivery.status || '').toLowerCase();
  if (!RETRYABLE_DELIVERY_STATUSES.includes(status)) return false;
  return !delivery.sent_at && !delivery.delivered_at && !delivery.opened_at && !delivery.clicked_at;
}

function hasDeliverySuccessSignal(delivery) {
  if (!delivery) return false;
  const status = String(delivery.status || '').toLowerCase();
  return TERMINAL_SUCCESS_STATUSES.includes(status)
    || !!delivery.sent_at
    || !!delivery.delivered_at
    || !!delivery.opened_at
    || !!delivery.clicked_at;
}

function applyDeliveryNoSuccessFilter(query, tableAlias = null) {
  const col = (name) => (tableAlias ? `${tableAlias}.${name}` : name);
  return query
    .whereNull(col('sent_at'))
    .whereNull(col('delivered_at'))
    .whereNull(col('opened_at'))
    .whereNull(col('clicked_at'));
}

function applyRetryableDeliveryFilter(query, tableAlias = null) {
  const col = (name) => (tableAlias ? `${tableAlias}.${name}` : name);
  return applyDeliveryNoSuccessFilter(query, tableAlias)
    .whereIn(col('status'), RETRYABLE_DELIVERY_STATUSES);
}

async function claimRetryableDeliveriesForResume(sendId, subscriberIds) {
  if (!subscriberIds.length) return [];
  const attemptToken = crypto.randomUUID();
  const rows = await applyRetryableDeliveryFilter(
    db('newsletter_send_deliveries')
      .where({ send_id: sendId })
      .whereIn('subscriber_id', subscriberIds),
  )
    // A resume attempt gets a fresh SendGrid message id; keep delayed events
    // from the previous attempt out of the provider_message_id fast path.
    .update({
      status: 'sending',
      provider_message_id: null,
      send_attempt_token: attemptToken,
      updated_at: new Date(),
    })
    .returning(['id', 'subscriber_id', 'send_attempt_token']);
  return rows.map((row) => ({ ...row, send_attempt_token: row.send_attempt_token || attemptToken }));
}

/**
 * Send a campaign (now). Used by the immediate-send route and the
 * scheduler tick. Idempotent-ish: refuses to re-send non-draft/non-scheduled
 * rows, and flips status to 'sending' before doing any external work.
 *
 * Per-recipient idempotency: resume sends only retry explicitly transient
 * rows (queued / failed / abandoned sending with no success or engagement
 * timestamps). Provider terminal rows such as delivered, bounced, or
 * complained are skipped.
 *
 * opts.force — bypass the 0-recipient guard. The route layer also
 *   pre-validates so the operator gets a 400 with a force=true hint;
 *   this in-sender check covers the scheduler-tick path (which has no
 *   pre-flight) and the rare race where the segment empties between
 *   pre-flight and dispatch.
 *
 * opts.preclaimed — caller already atomically moved the row to 'sending'.
 *   Used by resume so it never reopens a send as generic 'scheduled'.
 *
 * Returns { recipients, accepted, failed }.
 */
async function sendCampaign(sendId, opts = {}) {
  if (!sendgrid.isConfigured()) throw new Error('SendGrid not configured (SENDGRID_API_KEY missing)');

  const send = await db('newsletter_sends').where({ id: sendId }).first();
  if (!send) throw new Error('not found');
  if (!send.html_body && !send.text_body) throw new Error('body required');

  // 0-recipient guard — runs BEFORE the atomic claim so a no-op send
  // doesn't burn the row's status from draft/scheduled to sending only
  // to immediately land as 'sent' with recipient_count=0.
  if (!opts.force) {
    const c = await buildSubscriberQuery(send.segment_filter).count('* as c').first();
    if (Number(c?.c || 0) === 0) {
      const err = new Error('segment matches 0 active subscribers');
      err.code = 'EMPTY_SEGMENT';
      throw err;
    }
  }

  if (opts.preclaimed) {
    if (send.status !== 'sending') {
      const err = new Error('already sent or in progress');
      err.code = 'ALREADY_CLAIMED';
      throw err;
    }
  } else {
    // Atomic claim: only one caller can flip draft/scheduled -> sending.
    // Returning the rows lets us distinguish 'lost the race' (0 rows) from
    // 'won' (1 row). Without this guard, the immediate-send route + the
    // scheduler tick can both pick up the same row and double-send.
    // The race-loser is tagged so dispatch-side catch handlers can skip
    // the 'failed' flip because the row is actively sending under the winner.
    const claimed = await db('newsletter_sends')
      .where({ id: send.id })
      .whereIn('status', ['draft', 'scheduled'])
      .update({ status: 'sending', updated_at: new Date() })
      .returning('id');
    if (!claimed.length) {
      const err = new Error('already sent or in progress');
      err.code = 'ALREADY_CLAIMED';
      throw err;
    }
  }

  let subscribers = [];
  const useAb = !!send.subject_b;

  // Pre-seed per-recipient deliveries with A/B assignment. The onConflict
  // is the idempotency keystone for new sends — existing rows survive the
  // insert. Resume mode with existing rows skips this entirely so a changed
  // segment or new subscribers cannot expand an old campaign's audience.
  if (!opts.existingDeliveriesOnly) {
    subscribers = await buildSubscriberQuery(send.segment_filter);
    logger.info(`[newsletter] send ${send.id} → ${subscribers.length} subscribers (segment=${send.segment_filter ? JSON.stringify(send.segment_filter) : 'all'})`);
    const deliveryRows = subscribers.map((s) => ({
      send_id: send.id,
      subscriber_id: s.id,
      email: s.email,
      status: 'queued',
      ab_variant: useAb ? assignAbVariant() : null,
    }));
    if (deliveryRows.length) {
      await db('newsletter_send_deliveries').insert(deliveryRows).onConflict(['send_id', 'subscriber_id']).ignore();
    }
  }
  const existingDeliveries = await db('newsletter_send_deliveries')
    .where({ send_id: send.id })
    .select('id', 'subscriber_id', 'status', 'ab_variant', 'sent_at', 'delivered_at', 'opened_at', 'clicked_at', 'send_attempt_token');

  if (opts.existingDeliveriesOnly) {
    const retryableSubscriberIds = Array.from(new Set(existingDeliveries
      .filter(isRetryableDelivery)
      .map((d) => d.subscriber_id)
      .filter((id) => id !== null && id !== undefined)));
    subscribers = retryableSubscriberIds.length
      ? await excludeGloballySuppressed(
        db('newsletter_subscribers')
          .where({ status: 'active' })
          .whereIn('id', retryableSubscriberIds),
      ).select('id', 'email', 'unsubscribe_token', 'customer_id')
      : [];
    logger.info(`[newsletter] send ${send.id} → ${subscribers.length} active retryable recipient(s) from original delivery ledger (globally-suppressed excluded)`);
  }

  const deliveryBySub = new Map(existingDeliveries.map((d) => [d.subscriber_id, d]));
  const successfulDeliveryCount = existingDeliveries.filter(hasDeliverySuccessSignal).length;
  // Per-recipient idempotency: first sends target newly queued rows; resume
  // sends only retry explicitly transient rows. Provider terminal rows like
  // bounced/complained are not re-mailed.
  const subscribersToSend = subscribers.filter((s) => {
    const d = deliveryBySub.get(s.id);
    if (opts.existingDeliveriesOnly && !d) return false;
    return !d || isRetryableDelivery(d);
  });
  const recipientCount = opts.existingDeliveriesOnly ? existingDeliveries.length : subscribers.length;
  const skippedAlreadySent = recipientCount - subscribersToSend.length;
  if (skippedAlreadySent > 0) {
    logger.info(`[newsletter] send ${send.id} skipping ${skippedAlreadySent} recipient(s) already in non-retryable state (resume)`);
  }

  // Wrap the operator-written body in branded chrome (header + footer
  // + Waves logo). The unsubscribe URL is the SendGrid substitution
  // token — sendBatch injects a real per-recipient URL in its place.
  const htmlWithFooter = wrapNewsletter({
    body: send.html_body || '',
    unsubscribeUrl: '{{unsubscribe_url}}',
    preheader: send.preview_text || undefined,
    newsletterType: send.newsletter_type || undefined,
  });

  let accepted = 0, failed = 0;

  // O(1) variant lookup per subscriber. The previous .filter().find() was
  // O(n²) — at 5k subscribers that's 25M comparisons before the first
  // SendGrid call. Reads the canonical ab_variant from the persisted row
  // so a resume picks up the same A/B split the first pass assigned.
  const variantBySub = new Map(existingDeliveries.map((d) => [d.subscriber_id, d.ab_variant]));

  // Body for customer touchpoints — pure function on the campaign body,
  // hoisted out of the loop. Same for every recipient.
  const touchpointBody = send.text_body || stripHtml(send.html_body);

  // Split by variant so each batch uses the right subject line. When A/B is
  // off every delivery gets variant=null and we just ship one group.
  const variants = useAb ? ['a', 'b'] : [null];
  for (const variant of variants) {
    const group = subscribersToSend.filter((s) => (variantBySub.get(s.id) ?? null) === variant);
    if (!group.length) continue;

    const subjectForGroup = variant === 'b' ? send.subject_b : send.subject;

    // SendGrid caps personalizations at 1000 per request. Chunk for safety.
    const chunks = [];
    for (let i = 0; i < group.length; i += 500) chunks.push(group.slice(i, i + 500));

    for (const chunk of chunks) {
      let chunkToSend = chunk;
      let claimedDeliveryIds = [];
      let attemptTokenBySub = new Map();
      if (opts.existingDeliveriesOnly) {
        const claimedRows = await claimRetryableDeliveriesForResume(send.id, chunk.map((s) => s.id));
        const claimedBySub = new Map(claimedRows.map((d) => [d.subscriber_id, d]));
        chunkToSend = chunk.filter((s) => claimedBySub.has(s.id));
        claimedDeliveryIds = chunkToSend.map((s) => claimedBySub.get(s.id)?.id).filter(Boolean);
        attemptTokenBySub = new Map(chunkToSend.map((s) => [s.id, claimedBySub.get(s.id)?.send_attempt_token]).filter(([, token]) => token));
        if (!chunkToSend.length) continue;
      }

      const recipients = chunkToSend.map((s) => {
        const attemptToken = attemptTokenBySub.get(s.id);
        return {
          email: s.email,
          unsubscribeUrl: sendgrid.unsubscribeUrl(s.unsubscribe_token),
          // Greeting personalization: the assembler put {{greeting-name}}
          // in the body; this resolves it to ", FirstName" (or "" when the
          // subscriber row has no first name). Applies to both the HTML
          // and plain-text parts via SendGrid substitutions.
          substitutions: { [GREETING_NAME_TOKEN]: greetingNameValueFor(s.first_name) },
          // delivery_id rides on every SendGrid event webhook for this
          // recipient, so the handler can resolve back to the right row
          // even when the X-Message-Id from this batch was never observed
          // (lost-response case). send_id is included so the handler can
          // shortcut to the right table without a join.
          customArgs: {
            delivery_id: String(deliveryBySub.get(s.id)?.id || ''),
            send_id: String(send.id),
            ...(attemptToken ? { send_attempt_token: String(attemptToken) } : {}),
          },
        };
      });
      const subscriberIds = chunkToSend.map((s) => s.id);

      try {
        // sendBroadcast = sendBatch with the SENDGRID_ASM_GROUP_NEWSLETTER
        // group attached by default. Newsletter unsubs land in the
        // newsletter group only — service emails (invoices, reminders)
        // keep flowing.
        const result = await sendgrid.sendBroadcast({
          recipients,
          fromEmail: send.from_email,
          fromName: send.from_name,
          subject: subjectForGroup,
          html: htmlWithFooter,
          text: ensureLegalTextFooter(send.text_body, { unsubscribeUrl: '{{unsubscribe_url}}' }) || undefined,
          replyTo: send.reply_to,
          categories: ['newsletter', `send_${send.id}`, variant ? `variant_${variant}` : 'variant_none'],
        });

        // Single bulk UPDATE per chunk instead of N per-row updates. Knex
        // returns the affected row count so the SendGrid-accepted tally
        // stays accurate. True delivery is counted only from provider
        // webhooks after mailbox acceptance.
        const deliveryUpdateQuery = db('newsletter_send_deliveries').where({ send_id: send.id });
        if (opts.existingDeliveriesOnly) {
          deliveryUpdateQuery.where({ status: 'sending' }).whereIn('id', claimedDeliveryIds);
        } else {
          deliveryUpdateQuery.whereIn('subscriber_id', subscriberIds);
        }
        const updated = await (opts.existingDeliveriesOnly
          ? applyDeliveryNoSuccessFilter(deliveryUpdateQuery)
          : applyRetryableDeliveryFilter(deliveryUpdateQuery))
        .update({
          status: 'sent',
          provider_message_id: result.messageId,
          send_attempt_token: null,
          sent_at: new Date(),
          updated_at: new Date(),
        });
        accepted += updated;

        // Customer touchpoints in parallel — one per linked customer in
        // the chunk. Promise.allSettled so a single touchpoint failure
        // doesn't fail the campaign (touchpoints are best-effort comms
        // history; SendGrid already accepted the actual mail).
        const customerSubs = chunkToSend.filter((s) => s.customer_id);
        if (customerSubs.length) {
          const tpResults = await Promise.allSettled(customerSubs.map((s) =>
            recordTouchpoint({
              customerId: s.customer_id,
              channel: 'newsletter',
              direction: 'outbound',
              authorType: 'admin',
              adminUserId: send.created_by,
              contactEmail: s.email,
              subject: subjectForGroup,
              body: touchpointBody,
              metadata: {
                send_id: send.id,
                sendgrid_message_id: result.messageId,
                campaign_subject: subjectForGroup,
                ab_variant: variant,
              },
            })));
          const tpFailed = tpResults.filter((r) => r.status === 'rejected').length;
          if (tpFailed) {
            logger.warn(`[newsletter] ${tpFailed}/${customerSubs.length} touchpoint records failed for send ${send.id} (chunk size ${chunk.length})`);
          }
        }
      } catch (err) {
        logger.error(`[newsletter] batch failed for send ${send.id} variant=${variant}: ${err.message}`);
        const failureQuery = db('newsletter_send_deliveries').where({ send_id: send.id });
        if (opts.existingDeliveriesOnly) {
          failureQuery.where({ status: 'sending' }).whereIn('id', claimedDeliveryIds);
        } else {
          failureQuery.whereIn('subscriber_id', subscriberIds);
        }
        const updated = await (opts.existingDeliveriesOnly
          ? applyDeliveryNoSuccessFilter(failureQuery)
          : applyRetryableDeliveryFilter(failureQuery))
        .update({ status: 'failed', bounce_reason: err.message.slice(0, 500), updated_at: new Date() });
        failed += updated;
      }
    }
  }

  // Final state. If every recipient bounced into 'failed', the whole send
  // is 'failed' (operator can resume after fixing the cause). Otherwise we
  // call it 'sent' — partial failures live on as 'failed' deliveries that
  // resumeCampaign() can re-send without double-emailing the successes.
  const retryableRemaining = await applyRetryableDeliveryFilter(
    db('newsletter_send_deliveries').where({ send_id: send.id }),
  )
    .count('* as c')
    .first();
  const allFailed = Number(retryableRemaining?.c || 0) > 0
    && failed === subscribersToSend.length
    && subscribersToSend.length > 0
    && successfulDeliveryCount === 0;
  const finalSendUpdate = {
    status: allFailed ? 'failed' : 'sent',
    recipient_count: recipientCount,
    updated_at: new Date(),
  };
  if (!opts.preserveSentAt || !send.sent_at) {
    finalSendUpdate.sent_at = new Date();
  }
  await db('newsletter_sends').where({ id: send.id }).update(finalSendUpdate);

  if (finalSendUpdate.status === 'sent' && recipientCount > 0) {
    // Advance the calendar lifecycle (idempotent) so a sent newsletter's
    // calendar row reflects reality instead of being stuck at 'drafted'.
    try {
      await db('newsletter_calendar').where({ send_id: send.id }).update({ status: 'sent', updated_at: new Date() });
    } catch (err) {
      logger.warn(`[newsletter] calendar status update failed for send ${send.id}: ${err.message}`);
    }

    // First-'sent' only: advance events_raw.times_featured + recompute
    // freshness for the events this newsletter actually shipped, so the
    // recurring-series anti-repeat gate decays. Gated on !send.sent_at (a
    // resume carries preserveSentAt + an existing sent_at) so resumes don't
    // double-count. Trade-off: a send that FAILED first then succeeded on
    // resume won't feature — acceptable (under-count beats double-count).
    if (!send.sent_at) {
      try {
        await markEventsFeatured(send);
      } catch (err) {
        logger.warn(`[newsletter] times_featured update failed for send ${send.id}: ${err.message}`);
      }
    }

    const { sharePublishedNewsletter } = require('./content-scheduler');
    db('newsletter_sends').where({ id: send.id }).first().then((freshSend) => {
      if (freshSend) {
        sharePublishedNewsletter(freshSend).catch((err) => {
          logger.warn(`[newsletter] social share failed for send ${send.id}: ${err.message}`);
        });
      }
    }).catch(() => {});
  }

  return { recipients: recipientCount, accepted, failed, skipped_already_sent: skippedAlreadySent };
}

/**
 * Operator-triggered re-send of a campaign that previously failed or only
 * partially completed. Preclaims the row as 'sending' before handing it to
 * sendCampaign, then inherits sendCampaign's per-recipient idempotency filter:
 * only queued/failed/abandoned-sending rows with no success or engagement
 * timestamps get a fresh attempt.
 *
 * Refuses to resume rows that are still in 'sending' state (an active
 * sendCampaign call holds the work) or already 'sent' status with no
 * outstanding non-success deliveries.
 *
 * Returns { recipients, accepted, failed, skipped_already_sent }.
 */
async function prepareResumeCampaign(sendId) {
  if (!sendgrid.isConfigured()) throw new Error('SendGrid not configured (SENDGRID_API_KEY missing)');

  const send = await db('newsletter_sends').where({ id: sendId }).first();
  if (!send) throw new Error('not found');
  if (!send.html_body && !send.text_body) throw new Error('body required');
  if (send.status === 'draft' || send.status === 'scheduled') {
    const err = new Error('use sendCampaign, not resumeCampaign, for draft/scheduled sends');
    err.code = 'NOT_RESUMABLE';
    throw err;
  }
  if (send.status === 'sending') {
    // An active sendCampaign holds the work — refuse the resume so we
    // don't race two writers on the same delivery rows. Operator can
    // wait or, if the send genuinely stalled (worker died, status stuck),
    // flip the row to 'failed' manually first.
    const err = new Error('campaign is actively sending; refusing to resume');
    err.code = 'STILL_SENDING';
    throw err;
  }

  // Are there outstanding non-success deliveries to resume? If delivery
  // rows exist and all of them are already terminal-success, bail early so
  // the operator knows. If no rows exist yet, the first attempt failed
  // before pre-seeding and sendCampaign should reseed from subscribers.
  const deliveryTotal = await db('newsletter_send_deliveries')
    .where({ send_id: send.id })
    .count('* as c')
    .first();
  const totalDeliveries = Number(deliveryTotal?.c || 0);
  if (totalDeliveries === 0 && send.status !== 'failed') {
    const err = new Error('no outstanding deliveries to resume');
    err.code = 'NOTHING_TO_RESUME';
    throw err;
  }
  if (totalDeliveries > 0) {
    // Mirror the retry refetch's suppression exclusion so the "anything left to
    // resume?" count matches what sendCampaign will actually send — otherwise a
    // campaign whose only outstanding rows are globally-suppressed would falsely
    // report work remaining (and previously would have re-mailed them).
    const outstanding = await excludeGloballySuppressed(applyRetryableDeliveryFilter(
      db('newsletter_send_deliveries')
        .join('newsletter_subscribers', 'newsletter_subscribers.id', 'newsletter_send_deliveries.subscriber_id')
        .where({ 'newsletter_send_deliveries.send_id': send.id, 'newsletter_subscribers.status': 'active' }),
      'newsletter_send_deliveries',
    ))
      .count('* as c')
      .first();
    if (Number(outstanding?.c || 0) === 0) {
      const err = new Error('no outstanding deliveries to resume');
      err.code = 'NOTHING_TO_RESUME';
      throw err;
    }
  }

  // Claim directly as 'sending' only if the row is still in the state we
  // inspected above. This avoids a generic 'scheduled' window where the normal
  // /send path or scheduler could claim the send without resume constraints.
  const claimed = await db('newsletter_sends')
    .where({ id: send.id, status: send.status })
    .update({ status: 'sending', scheduled_for: null, updated_at: new Date() })
    .returning('id');
  if (!claimed.length) {
    const err = new Error('campaign was claimed by another worker');
    err.code = 'ALREADY_CLAIMED';
    throw err;
  }

  return { sendId: send.id, existingDeliveriesOnly: totalDeliveries > 0, preclaimed: true };
}

async function resumeCampaign(sendId) {
  const prepared = await prepareResumeCampaign(sendId);
  return sendCampaign(prepared.sendId, {
    force: true,
    preserveSentAt: true,
    existingDeliveriesOnly: prepared.existingDeliveriesOnly,
    preclaimed: prepared.preclaimed,
  });
}

/**
 * Process scheduled sends whose scheduled_for has passed. Called from the
 * global scheduler every minute. Processes sequentially so one slow send
 * can't stampede the others.
 */
async function processScheduledSends() {
  const { requiresClaimValidation } = require('../config/newsletter-types');
  const { validateNewsletterDraft } = require('../services/newsletter-validator');

  const due = await db('newsletter_sends')
    .where({ status: 'scheduled' })
    .where('scheduled_for', '<=', new Date())
    .orderBy('scheduled_for', 'asc')
    .limit(20);

  if (!due.length) return { processed: 0 };

  logger.info(`[newsletter-scheduler] ${due.length} scheduled send(s) due`);
  let processed = 0;
  for (const row of due) {
    try {
      // Validate AI-generated sends (flagship + Pest Insider) before dispatching
      if (requiresClaimValidation(row.newsletter_type)) {
        const recipientCount = Number(
          (await buildSubscriberQuery(row.segment_filter).count('* as c').first())?.c || 0
        );
        const { errors } = validateNewsletterDraft(row, { recipientCount });
        if (errors.length > 0) {
          logger.error(`[newsletter-scheduler] send ${row.id} blocked by validation: ${errors.join(', ')}`);
          await db('newsletter_sends').where({ id: row.id }).update({
            status: 'draft',
            scheduled_for: null,
            updated_at: new Date(),
          });
          // Keep the calendar in lockstep: this send is no longer scheduled, so
          // roll its linked calendar row back to 'drafted'. Without this the
          // row would stay 'scheduled' forever (autopilot then skips the week)
          // and /cancel-schedule can't repair it — the send is already draft.
          await db('newsletter_calendar').where({ send_id: row.id }).update({ status: 'drafted', updated_at: new Date() });
          continue;
        }
      }
      await sendCampaign(row.id);
      processed++;
    } catch (err) {
      // ALREADY_CLAIMED = another tick / manual send picked up this row
      // first. The other worker is actively sending — do NOT flip status
      // to failed or we'd overwrite an in-flight campaign.
      if (err.code === 'ALREADY_CLAIMED') {
        logger.info(`[newsletter-scheduler] send ${row.id} already claimed by another worker — skipping`);
        continue;
      }
      logger.error(`[newsletter-scheduler] send ${row.id} failed: ${err.message}`);
      try { await db('newsletter_sends').where({ id: row.id }).update({ status: 'failed' }); } catch { /* swallow */ }
    }
  }
  return { processed };
}

/**
 * Advance events_raw.times_featured + last_featured_at and recompute freshness
 * for every event a sent newsletter shipped (the locked send.event_ids). This
 * is what makes the recurring-series anti-repeat gate actually decay for the
 * automated path — previously only a manual admin "feature" click bumped the
 * counter, so an approved-but-never-featured recurring event stayed
 * fresh_series_launch forever and could headline every week.
 */
async function markEventsFeatured(send) {
  let ids = [];
  try {
    ids = Array.isArray(send.event_ids) ? send.event_ids : JSON.parse(send.event_ids || '[]');
  } catch { ids = []; }
  if (!Array.isArray(ids) || ids.length === 0) return;

  const { classifyFreshness } = require('./event-freshness');

  // Lock + read + write each event row inside a transaction (SELECT ... FOR
  // UPDATE) so two sends that ship the same event can't both read the same
  // times_featured and write back the same value — which would lose an
  // increment and decay the recurring-series gate too slowly. The row lock
  // serializes them and keeps the recomputed freshness consistent with the
  // final count. One row per transaction (≤12 events per send).
  for (const id of ids) {
    await db.transaction(async (trx) => {
      const row = await trx('events_raw').where({ id }).forUpdate()
        .first('id', 'event_type', 'times_featured', 'start_at', 'end_at');
      if (!row) return;
      const nextFeatured = (row.times_featured || 0) + 1;
      const { freshness_status, freshness_score } = classifyFreshness({ ...row, times_featured: nextFeatured });
      await trx('events_raw').where({ id }).update({
        times_featured: nextFeatured,
        last_featured_at: new Date(),
        freshness_status,
        freshness_score,
        updated_at: new Date(),
      });
    });
  }
}

module.exports = { sendCampaign, prepareResumeCampaign, resumeCampaign, processScheduledSends, buildSubscriberQuery, excludeGloballySuppressed, markEventsFeatured };
