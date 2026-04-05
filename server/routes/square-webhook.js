const express = require('express');
const router = express.Router();
const db = require('../models/db');
const logger = require('../services/logger');
const TwilioService = require('../services/twilio');

const WAVES_FROM = '+19413187612';

// =========================================================================
// POST /api/webhooks/square/payment — Square payment/invoice events
//
// Replaces Zapier zaps:
//   #9  Invoice SMS — sends SMS when new unpaid invoice created
//   #14 New Payment Processing SMS — sends thank-you SMS on payment
// =========================================================================
router.post('/payment', async (req, res) => {
  try {
    const event = req.body;
    logger.info(`[square-webhook] Event: ${event.type}`);

    // ── PAYMENT COMPLETED (#14) ──
    if (event.type === 'payment.completed') {
      const payment = event.data?.object?.payment;
      if (!payment) return res.sendStatus(200);

      const squareCustomerId = payment.customer_id;
      const amount = (payment.amount_money?.amount || 0) / 100;
      const receiptUrl = payment.receipt_url || '';

      if (squareCustomerId && amount > 0) {
        const customer = await db('customers').where({ square_customer_id: squareCustomerId }).first();

        if (customer) {
          // Record payment
          await db('payments').insert({
            customer_id: customer.id,
            amount,
            status: 'paid',
            payment_date: new Date().toISOString().split('T')[0],
            description: 'Square payment',
            metadata: JSON.stringify({ square_payment_id: payment.id, receipt_url: receiptUrl }),
          }).catch(() => {});

          // Trigger balance reminder auto-detect
          try {
            const BalanceReminder = require('../services/workflows/balance-reminder');
            await BalanceReminder.onPaymentReceived(customer.id, amount);
          } catch (e) { logger.error(`Balance auto-detect failed: ${e.message}`); }

          // Update customer's total revenue
          try {
            const currentRev = parseFloat(customer.total_revenue || 0);
            await db('customers').where({ id: customer.id }).update({
              total_revenue: currentRev + amount,
              last_payment_at: new Date(),
            });
          } catch { /* column might not exist */ }

          // Send thank-you SMS (#14)
          if (customer.phone) {
            try {
              const body = `Hello ${customer.first_name}! Thank you for your payment of $${amount.toFixed(2)} — we truly appreciate your business. 🌊\n\n` +
                (receiptUrl ? `View your receipt: ${receiptUrl}\n\n` : '') +
                `If you have any questions, reply here or call (941) 318-7612.\n\n` +
                `— Waves Pest Control`;

              await TwilioService.sendSMS(customer.phone, body);
              logger.info(`[square-webhook] Payment SMS sent to ${customer.first_name} (${customer.phone}) for $${amount.toFixed(2)}`);
            } catch (smsErr) {
              logger.error(`[square-webhook] Payment SMS failed: ${smsErr.message}`);
            }
          }

          // Log activity
          await db('activity_log').insert({
            customer_id: customer.id,
            action: 'payment_processed',
            description: `Payment received: $${amount.toFixed(2)} from ${customer.first_name} ${customer.last_name}`,
            metadata: JSON.stringify({ amount, squarePaymentId: payment.id, receiptUrl }),
          }).catch(() => {});

          logger.info(`[square-webhook] Payment processed: $${amount} from ${customer.first_name} ${customer.last_name}`);
        }
      }
    }

    // ── INVOICE CREATED / PUBLISHED (#9) ──
    if (event.type === 'invoice.created' || event.type === 'invoice.published') {
      const invoice = event.data?.object?.invoice;
      if (!invoice) return res.sendStatus(200);

      // Only send SMS for unpaid invoices
      const status = (invoice.status || '').toUpperCase();
      if (status !== 'UNPAID' && status !== 'SENT' && status !== 'SCHEDULED') {
        return res.sendStatus(200);
      }

      const recipient = invoice.primary_recipient;
      if (!recipient) return res.sendStatus(200);

      const squareCustomerId = recipient.customer_id;
      const phone = recipient.phone_number;
      const firstName = recipient.given_name || '';
      const invoiceTitle = invoice.title || 'your service';
      const publicUrl = invoice.public_url || '';
      const totalAmount = (invoice.payment_requests?.[0]?.computed_amount_money?.amount || 0) / 100;
      const serviceDate = invoice.sale_or_service_date || '';

      // Format the service date
      let formattedDate = '';
      if (serviceDate) {
        try {
          formattedDate = new Date(serviceDate + 'T12:00:00').toLocaleDateString('en-US', {
            weekday: 'long', month: 'long', day: 'numeric', year: 'numeric',
          });
        } catch { formattedDate = serviceDate; }
      }

      // Find customer in portal DB
      let customer = null;
      if (squareCustomerId) {
        customer = await db('customers').where({ square_customer_id: squareCustomerId }).first();
      }
      if (!customer && phone) {
        customer = await db('customers').where({ phone }).first();
      }

      const customerPhone = customer?.phone || phone;
      const customerName = customer?.first_name || firstName;

      if (customerPhone) {
        try {
          const body = `Hello ${customerName}! Your invoice for ${invoiceTitle}` +
            (formattedDate ? ` completed on ${formattedDate}` : '') +
            ` is ready.\n\n` +
            (totalAmount > 0 ? `Amount due: $${totalAmount.toFixed(2)}\n` : '') +
            (publicUrl ? `\nView & pay here: ${publicUrl}\n` : '') +
            `\nIf you have any questions, reply here or call (941) 318-7612.\n\n` +
            `— Waves Pest Control 🌊`;

          await TwilioService.sendSMS(customerPhone, body);
          logger.info(`[square-webhook] Invoice SMS sent to ${customerName} (${customerPhone}) for "${invoiceTitle}"`);
        } catch (smsErr) {
          logger.error(`[square-webhook] Invoice SMS failed: ${smsErr.message}`);
        }
      }

      // Log activity
      if (customer) {
        await db('activity_log').insert({
          customer_id: customer.id,
          action: 'invoice_sent',
          description: `Invoice created: ${invoiceTitle} ($${totalAmount.toFixed(2)})`,
          metadata: JSON.stringify({ invoiceId: invoice.id, amount: totalAmount, publicUrl }),
        }).catch(() => {});
      }
    }

    // ── INVOICE PAYMENT MADE ──
    if (event.type === 'invoice.payment_made') {
      const invoice = event.data?.object?.invoice;
      if (!invoice) return res.sendStatus(200);

      const squareCustomerId = invoice.primary_recipient?.customer_id;
      if (squareCustomerId) {
        const customer = await db('customers').where({ square_customer_id: squareCustomerId }).first();
        if (customer) {
          const amount = (invoice.payment_requests?.[0]?.computed_amount_money?.amount || 0) / 100;
          await db('payments').insert({
            customer_id: customer.id,
            amount,
            status: 'paid',
            payment_date: new Date().toISOString().split('T')[0],
            description: `Invoice: ${invoice.title || 'service'}`,
          }).catch(() => {});

          await db('activity_log').insert({
            customer_id: customer.id,
            action: 'invoice_paid',
            description: `Invoice paid: ${invoice.title || 'service'} ($${amount.toFixed(2)})`,
          }).catch(() => {});
        }
      }
    }
  } catch (err) {
    logger.error(`[square-webhook] Error: ${err.message}`);
  }

  res.sendStatus(200);
});

module.exports = router;
