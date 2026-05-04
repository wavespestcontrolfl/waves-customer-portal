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
const { wrapNewsletter } = require('./email-template');
const { recordTouchpoint } = require('./conversations');

function stripHtml(html) {
  if (!html) return '';
  return html.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
}

function buildSubscriberQuery(segmentFilter) {
  let q = db('newsletter_subscribers').where({ status: 'active' });
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

/**
 * Send a campaign (now). Used by the immediate-send route and the
 * scheduler tick. Idempotent-ish: refuses to re-send non-draft/non-scheduled
 * rows, and flips status to 'sending' before doing any external work.
 *
 * opts.force — bypass the 0-recipient guard. The route layer also
 *   pre-validates so the operator gets a 400 with a force=true hint;
 *   this in-sender check covers the scheduler-tick path (which has no
 *   pre-flight) and the rare race where the segment empties between
 *   pre-flight and dispatch.
 *
 * Returns { recipients, delivered, failed }.
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

  // Atomic claim: only one caller can flip draft/scheduled → sending.
  // Returning the rows lets us distinguish 'lost the race' (0 rows) from
  // 'won' (1 row). Without this guard, the immediate-send route + the
  // scheduler tick can both pick up the same row and double-send.
  // The race-loser is tagged so dispatch-side catch handlers can skip
  // the 'failed' flip — the row is actively sending under the winner.
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

  const subscribers = await buildSubscriberQuery(send.segment_filter);
  logger.info(`[newsletter] send ${send.id} → ${subscribers.length} subscribers (segment=${send.segment_filter ? JSON.stringify(send.segment_filter) : 'all'})`);

  const useAb = !!send.subject_b;

  // Pre-seed per-recipient deliveries with A/B assignment.
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

  // Wrap the operator-written body in branded chrome (header + footer
  // + Waves logo). The unsubscribe URL is the SendGrid substitution
  // token — sendBatch injects a real per-recipient URL in its place.
  const htmlWithFooter = wrapNewsletter({
    body: send.html_body || '',
    unsubscribeUrl: '{{unsubscribe_url}}',
    preheader: send.preview_text || undefined,
  });

  let delivered = 0, failed = 0;

  // O(1) variant lookup per subscriber. The previous .filter().find() was
  // O(n²) — at 5k subscribers that's 25M comparisons before the first
  // SendGrid call.
  const variantBySub = new Map(deliveryRows.map((d) => [d.subscriber_id, d.ab_variant]));

  // Body for customer touchpoints — pure function on the campaign body,
  // hoisted out of the loop. Same for every recipient.
  const touchpointBody = send.text_body || stripHtml(send.html_body);

  // Split by variant so each batch uses the right subject line. When A/B is
  // off every delivery gets variant=null and we just ship one group.
  const variants = useAb ? ['a', 'b'] : [null];
  for (const variant of variants) {
    const group = subscribers.filter((s) => (variantBySub.get(s.id) ?? null) === variant);
    if (!group.length) continue;

    const subjectForGroup = variant === 'b' ? send.subject_b : send.subject;

    // SendGrid caps personalizations at 1000 per request. Chunk for safety.
    const chunks = [];
    for (let i = 0; i < group.length; i += 500) chunks.push(group.slice(i, i + 500));

    for (const chunk of chunks) {
      const recipients = chunk.map((s) => ({
        email: s.email,
        unsubscribeUrl: sendgrid.unsubscribeUrl(s.unsubscribe_token),
      }));
      const subscriberIds = chunk.map((s) => s.id);

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
          text: send.text_body || undefined,
          replyTo: send.reply_to,
          categories: ['newsletter', `send_${send.id}`, variant ? `variant_${variant}` : 'variant_none'],
        });

        // Single bulk UPDATE per chunk instead of N per-row updates. Knex
        // returns the affected row count so the delivered tally stays
        // accurate. The (send_id, subscriber_id) unique constraint
        // guarantees one row per subscriber.
        const updated = await db('newsletter_send_deliveries')
          .where({ send_id: send.id })
          .whereIn('subscriber_id', subscriberIds)
          .update({
            status: 'sent',
            provider_message_id: result.messageId,
            sent_at: new Date(),
            updated_at: new Date(),
          });
        delivered += updated;

        // Customer touchpoints in parallel — one per linked customer in
        // the chunk. Promise.allSettled so a single touchpoint failure
        // doesn't fail the campaign (touchpoints are best-effort comms
        // history; SendGrid already accepted the actual mail).
        const customerSubs = chunk.filter((s) => s.customer_id);
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
        const updated = await db('newsletter_send_deliveries')
          .where({ send_id: send.id })
          .whereIn('subscriber_id', subscriberIds)
          .update({ status: 'failed', bounce_reason: err.message.slice(0, 500), updated_at: new Date() });
        failed += updated;
      }
    }
  }

  await db('newsletter_sends').where({ id: send.id }).update({
    status: failed === subscribers.length && subscribers.length > 0 ? 'failed' : 'sent',
    recipient_count: subscribers.length,
    delivered_count: delivered,
    sent_at: new Date(),
    updated_at: new Date(),
  });

  return { recipients: subscribers.length, delivered, failed };
}

/**
 * Process scheduled sends whose scheduled_for has passed. Called from the
 * global scheduler every minute. Processes sequentially so one slow send
 * can't stampede the others.
 */
async function processScheduledSends() {
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

module.exports = { sendCampaign, processScheduledSends, buildSubscriberQuery };
