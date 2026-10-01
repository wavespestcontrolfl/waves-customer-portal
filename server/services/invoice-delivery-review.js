const db = require('../models/db');
const logger = require('./logger');

function reviewDecisionForInvoice(invoice, requestReview, reviewDelayMinutes) {
  if (requestReview != null) return { requestReview, reviewDelayMinutes };
  const inherited = Boolean(invoice.scheduled_request_review);
  return { requestReview: inherited,
    reviewDelayMinutes: inherited && reviewDelayMinutes == null
      ? invoice.scheduled_review_delay_minutes : reviewDelayMinutes };
}

// Both invoice send paths must make the review decision AFTER the issued-
// invoice closeout, using the then-current service-record linkage. A newly
// closed visit or its durable provenance owns the ask; an unpaid completion
// invoice waits for its payment. The optional fallback preserves the
// completion finalizer's behavior if its post-closeout re-read misses.
async function enrollReviewAfterInvoiceDelivery({ invoiceId, issuedCloseout, delayMinutes, source = null, fallbackInvoice = null }) {
  const sourceSuffix = source ? ` (source=${source})` : '';
  try {
    if (issuedCloseout?.closed) {
      logger.info(`[invoice] Review ask suppressed for invoice ${invoiceId}: the invoice-issued closeout completed visit ${issuedCloseout.visitId} quietly${sourceSuffix}`);
      return;
    }
    const fresh = await db('invoices').where({ id: invoiceId })
      .select('customer_id', 'service_record_id', 'status').first();
    const invoice = fresh ? { ...fallbackInvoice, ...fresh } : fallbackInvoice;
    if (!invoice) return;
    if (invoice.service_record_id && !['paid', 'prepaid'].includes(String(invoice.status || ''))) {
      logger.info(`[invoice] Review ask deferred to payment for invoice ${invoiceId} (unpaid completion invoice${source ? `, source=${source}` : ''})`);
      return;
    }
    const { issuedCloseoutOwnsRecord } = require('./invoice-issued-closeout');
    if (await issuedCloseoutOwnsRecord(invoice.service_record_id)) {
      logger.info(`[invoice] Review ask suppressed for invoice ${invoiceId}: record ${invoice.service_record_id} was committed by the invoice-issued closeout${sourceSuffix}`);
      return;
    }
    const ReviewService = require('./review-request');
    await ReviewService.enrollPostService({
      customerId: fallbackInvoice?.customer_id || invoice.customer_id,
      serviceRecordId: invoice.service_record_id || null,
      triggeredBy: 'auto',
      delayMinutes,
    });
  } catch (err) {
    logger.error(`[invoice] Review request schedule failed${source ? ` after ${source}` : ''}: ${err.message}`);
  }
}

module.exports = { reviewDecisionForInvoice, enrollReviewAfterInvoiceDelivery };
