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
    q = q.whereRaw('tags ?| array[' + f.tags.map(() => '?').join(',') + ']', f.tags);
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
 * Returns { recipients, delivered, failed }.
 */
async function sendCampaign(sendId) {
  if (!sendgrid.isConfigured()) throw new Error('SendGrid not configured (SENDGRID_API_KEY missing)');

  const send = await db('newsletter_sends').where({ id: sendId }).first();
  if (!send) throw new Error('not found');
  if (!['draft', 'scheduled'].includes(send.status)) throw new Error('already sent or in progress');
  if (!send.html_body && !send.text_body) throw new Error('body required');

  await db('newsletter_sends').where({ id: send.id }).update({ status: 'sending', updated_at: new Date() });

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

  const htmlWithFooter = sendgrid.injectUnsubscribeFooter(send.html_body || '');

  let delivered = 0, failed = 0;

  // Split by variant so each batch uses the right subject line. When A/B is
  // off every delivery gets variant=null and we just ship one group.
  const variants = useAb ? ['a', 'b'] : [null];
  for (const variant of variants) {
    const group = subscribers.filter((s) => {
      const row = deliveryRows.find((d) => d.subscriber_id === s.id);
      return (row?.ab_variant ?? null) === variant;
    });
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

      try {
        const result = await sendgrid.sendBatch({
          recipients,
          fromEmail: send.from_email,
          fromName: send.from_name,
          subject: subjectForGroup,
          html: htmlWithFooter,
          text: send.text_body || undefined,
          replyTo: send.reply_to,
          categories: ['newsletter', `send_${send.id}`, variant ? `variant_${variant}` : 'variant_none'],
        });

        for (const s of chunk) {
          await db('newsletter_send_deliveries')
            .where({ send_id: send.id, subscriber_id: s.id })
            .update({
              status: 'sent',
              resend_message_id: result.messageId,
              sent_at: new Date(),
              updated_at: new Date(),
            });
          delivered++;

          if (s.customer_id) {
            await recordTouchpoint({
              customerId: s.customer_id,
              channel: 'newsletter',
              direction: 'outbound',
              authorType: 'admin',
              adminUserId: send.created_by,
              contactEmail: s.email,
              subject: subjectForGroup,
              body: send.text_body || stripHtml(send.html_body),
              metadata: {
                send_id: send.id,
                sendgrid_message_id: result.messageId,
                campaign_subject: subjectForGroup,
                ab_variant: variant,
              },
            });
          }
        }
      } catch (err) {
        logger.error(`[newsletter] batch failed for send ${send.id} variant=${variant}: ${err.message}`);
        for (const s of chunk) {
          await db('newsletter_send_deliveries')
            .where({ send_id: send.id, subscriber_id: s.id })
            .update({ status: 'failed', bounce_reason: err.message.slice(0, 500), updated_at: new Date() });
          failed++;
        }
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
      logger.error(`[newsletter-scheduler] send ${row.id} failed: ${err.message}`);
      try { await db('newsletter_sends').where({ id: row.id }).update({ status: 'failed' }); } catch { /* swallow */ }
    }
  }
  return { processed };
}

module.exports = { sendCampaign, processScheduledSends, buildSubscriberQuery };
